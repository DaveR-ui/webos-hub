#!/usr/bin/env node
/*
 * WebOS Hub - reproducible, hygiene-safe packaging.
 *
 * `ares-package .` on the repo root happily packs `.git/`, `build/` and
 * `tools/` into the IPK (its `-e` exclude patterns proved unreliable), which
 * bloated the package from ~51 KB to ~140 KB and shipped the whole git repo.
 *
 * This script stages ONLY the files that are meant to ship, then packages the
 * staged copy, so the IPK can never contain VCS metadata or dev tooling.
 *
 * Usage:
 *   node tools/build.mjs
 *   ARES_BIN=/path/to/ares-package node tools/build.mjs
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const stageRoot = path.join(buildDir, 'stage');
const stageApp = path.join(stageRoot, 'app');
const stageService = path.join(stageRoot, 'service');

/* Files/dirs that belong inside the shipped web app. Everything else
 * (.git, build, tools, README, package.json, .gitignore) stays out. */
const APP_ENTRIES = [
	'appinfo.json',
	'index.html',
	'icon.png',
	'largeIcon.png',
	'css',
	'js',
	'webOSTVjs-1.2.13'
];

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch (e) {
		return false;
	}
}

async function main() {
	await rm(stageRoot, { recursive: true, force: true });
	await mkdir(stageApp, { recursive: true });
	await mkdir(stageService, { recursive: true });

	for (const entry of APP_ENTRIES) {
		const src = path.join(root, entry);
		if (!(await exists(src))) {
			console.error('build: missing required app entry: ' + entry);
			process.exit(1);
		}
		await cp(src, path.join(stageApp, entry), { recursive: true });
	}

	await cp(path.join(root, 'services'), stageService, { recursive: true });

	/* Defensive: never ship node_modules. */
	await rm(path.join(stageService, 'node_modules'), { recursive: true, force: true });

	const aresBin = process.env.ARES_BIN || 'ares-package';
	console.log('build: packaging staged app + service with ' + aresBin + ' ...');
	execFileSync(aresBin, [stageApp, stageService, '-o', buildDir], { stdio: 'inherit' });

	/* The staged copy is an implementation detail; leave only the IPK behind. */
	await rm(stageRoot, { recursive: true, force: true });
	console.log('build: done (IPK written to build/)');
}

main().catch(function (err) {
	console.error('build: FAILED - ' + (err && err.message ? err.message : String(err)));
	process.exit(1);
});
