// The pi-env daemon that @earendil-works/pi-env ships for this machine, started over a local pipe instead of SSH.
import { Connection, packagedDaemon, type RemotePlatform } from "@earendil-works/pi-env";

/** Path of the packaged daemon binary for the machine running the experiment. */
export function localDaemon(): string {
	const platforms: Partial<Record<NodeJS.Platform, RemotePlatform["platform"]>> = {
		linux: "linux",
		darwin: "darwin",
		win32: "windows",
		android: "android",
	};
	const platform = platforms[process.platform];
	const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
	if (!platform || !arch) throw new Error(`pi-env ships no daemon for ${process.platform}/${process.arch}`);
	return packagedDaemon({ platform, arch });
}

/** A connection that starts the local daemon on its first request (and again after it is lost). */
export function localConnection(): Connection {
	return new Connection({ command: [localDaemon()] });
}
