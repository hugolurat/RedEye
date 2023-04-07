import { Beacon, Host, Link, Server } from '@redeye/models';
import type { EntityManager } from '../../types';
import { Field, ObjectType } from 'type-graphql';
import { Loaded } from '@mikro-orm/core';

export const ensureTreeHidden = async (
	em: EntityManager,
	id: string,
	hidden: boolean,
	beaconsToHide: string[]
): Promise<void> => {
	const links = await em.find(Link, { origin: { id } });
	for (const link of links) {
		const destinationBeacon = link.destination;
		if (destinationBeacon) {
			const destinationLinks = await em.find(Link, { destination: { id: destinationBeacon?.id } });
			if (destinationLinks.every((l) => l.origin?.hidden === hidden || beaconsToHide.includes(l.origin?.id || ''))) {
				await em.nativeUpdate(Beacon, { id: destinationBeacon.id }, { hidden });
				await ensureTreeHidden(em, destinationBeacon.id, hidden, beaconsToHide);
			}
		}
	}
};

export const findTree = async (
	em: EntityManager,
	id: string,
	beaconsToHide: string[],
	beaconsThatWillBeHidden: string[]
): Promise<void> => {
	const links = await em.find(Link, { origin: { id } });
	for (const link of links) {
		const destinationBeacon = link.destination;
		if (destinationBeacon) {
			const destinationLinks = await em.find(Link, { destination: { id: destinationBeacon?.id } });
			if (destinationLinks.every((l) => l.origin?.hidden === false || beaconsToHide.includes(l.origin?.id || ''))) {
				beaconsThatWillBeHidden.push(destinationBeacon.id);
				await findTree(em, destinationBeacon.id, beaconsToHide, beaconsThatWillBeHidden);
			}
		}
	}
};

@ObjectType()
export class CantHideEntities {
	constructor(args: Partial<CantHideEntities> = {}) {
		Object.assign(this, args);
	}

	@Field(() => [String], { nullable: true })
	servers: string[] = [];

	@Field(() => [String], { nullable: true })
	hosts: string[] = [];

	@Field(() => [String], { nullable: true })
	beacons: string[] = [];
}

export const checkCanHideEntities = async ({
	em,
	hostsToHide = [],
	beaconsToHide = [],
}: {
	em: EntityManager;
	beaconsToHide?: string[];
	hostsToHide?: string[];
}) => {
	const beacons = beaconsToHide?.length
		? await em.find(Beacon, { id: beaconsToHide }, { populate: ['host', 'host.beacons'] })
		: [];
	const hosts = hostsToHide?.length
		? await em.find(Host, { id: hostsToHide, cobaltStrikeServer: false }, { populate: true })
		: [];
	const servers = hostsToHide?.length ? await em.find(Server, { id: hostsToHide }, { populate: true }) : [];
	const notHiddenHosts = await em.find(Host, { hidden: false, cobaltStrikeServer: false });
	const notHiddenServers = await em.find(Host, { hidden: false, cobaltStrikeServer: true });
	const canHideBeacons: string[] = [];
	const canHideHosts: string[] = [];
	const canHideServers: string[] = [];
	const cantHideBeacons = [];
	const hostBeacons: Record<string, Loaded<Beacon>[]> = {};
	const serverBeacons: Record<string, number> = {};
	for (const beacon of beacons) {
		const beaconsThatWillBeHidden: string[] = [beacon.id];
		const beaconHost = beacon.host!;

		// Find all sub beacons that will be hidden
		await findTree(em, beacon.id, beaconsToHide, beaconsThatWillBeHidden);
		if (beacon.server && !serverBeacons[beacon.server.id]) {
			serverBeacons[beacon.server.id] = await em.count(Beacon, { server: { id: beacon.server.id }, hidden: false });
		}
		if (!hostBeacons[beaconHost.id]) {
			hostBeacons[beaconHost.id] = (await beaconHost.beacons.init()).getItems();
		}
		const hostBeaconsNotHidden = hostBeacons[beaconHost.id].filter((beacon) => !beacon.hidden);
		if (
			checkCanHide(hostBeaconsNotHidden, canHideBeacons) &&
			beaconsThatWillBeHidden.length < (beacon.server?.id ? serverBeacons[beacon.server.id] - 1 || 0 : 0)
		) {
			canHideBeacons.push(beacon.id);
		} else {
			cantHideBeacons.push(beacon);
		}
	}

	const cantHideHosts = hosts.filter((host) => {
		if (checkCanHide(notHiddenHosts, canHideHosts)) {
			canHideHosts.push(host.id);
			return false;
		}
		return true;
	});

	const cantHideServers = servers.filter((server) => {
		if (checkCanHide(notHiddenServers, canHideServers)) {
			canHideServers.push(server.id);
			return false;
		}
		return true;
	});

	return {
		cantHideServers: cantHideServers.map((host) => host.id),
		cantHideBeacons: cantHideBeacons.map((beacon) => beacon.id),
		cantHideHosts: cantHideHosts.map((host) => host.id),
	};
};

export const checkCanHide = (entities: (Host | Beacon | Server | string)[], hiddenHostIds: string[]) =>
	(entities.length > 1 && hiddenHostIds.length - 1 !== entities.length) || entities.length !== 1;

export const defaultHidden = (hidden?: boolean) => (!hidden ? { hidden } : {});
export const beaconHidden = (hidden?: boolean) => (!hidden ? { beacon: { hidden } } : {});
