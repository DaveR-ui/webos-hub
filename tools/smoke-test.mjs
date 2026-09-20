#!/usr/bin/env node
/*
 * WebOS Hub - live smoke test.
 *
 * Exercises exactly the call paths the app uses:
 *   Jellyfin:  GET /System/Info/Public -> POST /Users/AuthenticateByName
 *              -> GET /Users/{userId}/Views
 *              -> GET /Users/{userId}/Items (movies)
 *              -> GET /Users/{userId}/Items/Resume
 *              -> GET /Items/{itemId}/Images/Primary
 *   Sunshine:  GET /api/apps, GET /api/config (self-signed TLS, insecure allowed)
 *
 * Credentials come from the environment:
 *   JELLYFIN_USER, JELLYFIN_PASS, SUNSHINE_USER, SUNSHINE_PASS
 * URLs are overridable with JELLYFIN_URL, SUNSHINE_URL.
 *
 * Prints a PASS/FAIL summary and exits non-zero when anything fails.
 */
import http from 'node:http';
import https from 'node:https';

const JELLYFIN_URL = (process.env.JELLYFIN_URL || 'http://192.168.0.205:8096').replace(/\/+$/, '');
const SUNSHINE_URL = (process.env.SUNSHINE_URL || 'https://192.168.0.205:47990').replace(/\/+$/, '');

const CLIENT_NAME = 'WebOS Hub Smoke Test';
const DEVICE_NAME = 'node';
const DEVICE_ID = 'weboshub-smoketest';
const APP_VERSION = '1.0.0';

const results = [];
let smokeItems = [];

function record(name, ok, detail) {
	results.push({ name, ok, detail });
	const tag = ok ? 'PASS' : 'FAIL';
	console.log(`[${tag}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail) {
	results.push({ name, ok: true, detail: `WARN: ${detail}` });
	console.log(`[WARN] ${name} - ${detail}`);
}

function request(target, options = {}) {
	const parsed = new URL(target);
	const isHttps = parsed.protocol === 'https:';
	const transport = isHttps ? https : http;
	return new Promise((resolve, reject) => {
		const req = transport.request(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port || (isHttps ? 443 : 80),
				path: `${parsed.pathname}${parsed.search}`,
				method: options.method || 'GET',
				headers: options.headers || {},
				rejectUnauthorized: options.insecure === true ? false : true
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks)
					})
				);
			}
		);
		req.setTimeout(15000, () => req.destroy(new Error('timeout after 15000ms')));
		req.on('error', reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable ${name}`);
	}
	return value;
}

function mediaBrowserAuth(token) {
	const parts = [];
	if (token) parts.push(`Token="${token}"`);
	parts.push(`Client="${CLIENT_NAME}"`);
	parts.push(`Device="${DEVICE_NAME}"`);
	parts.push(`DeviceId="${DEVICE_ID}"`);
	parts.push(`Version="${APP_VERSION}"`);
	return `MediaBrowser ${parts.join(', ')}`;
}

async function main() {
	const jellyfinUser = requireEnv('JELLYFIN_USER');
	const jellyfinPass = requireEnv('JELLYFIN_PASS');
	const sunshineUser = process.env.SUNSHINE_USER || '';
	const sunshinePass = process.env.SUNSHINE_PASS || '';

	// ------------------------------- Jellyfin --------------------------------
	console.log(`\n== Jellyfin (${JELLYFIN_URL}) ==`);

	let publicInfo;
	try {
		const res = await request(`${JELLYFIN_URL}/System/Info/Public`);
		const body = JSON.parse(res.body.toString('utf8') || '{}');
		publicInfo = body;
		record(
			'GET /System/Info/Public',
			res.status === 200 && !!body.Version,
			`HTTP ${res.status}, ProductName=${body.ProductName}, Version=${body.Version}`
		);
	} catch (err) {
		record('GET /System/Info/Public', false, err.message);
	}

	let token = null;
	let userId = null;
	try {
		const res = await request(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Emby-Authorization': mediaBrowserAuth(null)
			},
			body: JSON.stringify({ Username: jellyfinUser, Pw: jellyfinPass })
		});
		const body = JSON.parse(res.body.toString('utf8') || '{}');
		token = body.AccessToken || null;
		userId = body.User && body.User.Id ? body.User.Id : null;
		record(
			'POST /Users/AuthenticateByName',
			res.status === 200 && !!token && !!userId,
			`HTTP ${res.status}, userId=${userId}`
		);
	} catch (err) {
		record('POST /Users/AuthenticateByName', false, err.message);
	}

	if (token && userId) {
		const authHeaders = { Authorization: mediaBrowserAuth(token) };

		try {
			const res = await request(`${JELLYFIN_URL}/Users/${userId}/Views`, { headers: authHeaders });
			const body = JSON.parse(res.body.toString('utf8') || '{}');
			const names = (body.Items || []).map((v) => v.Name).join(', ');
			record('GET /Users/{userId}/Views', res.status === 200, `HTTP ${res.status}, libraries=[${names}]`);
		} catch (err) {
			record('GET /Users/{userId}/Views', false, err.message);
		}

		try {
			const res = await request(
				`${JELLYFIN_URL}/Users/${userId}/Items?IncludeItemTypes=Movie&Recursive=true&Limit=6&SortBy=SortName`,
				{ headers: authHeaders }
			);
			const body = JSON.parse(res.body.toString('utf8') || '{}');
			record(
				'GET /Users/{userId}/Items (Movie)',
				res.status === 200,
				`HTTP ${res.status}, TotalRecordCount=${body.TotalRecordCount}`
			);
			smokeItems = body.Items || [];
		} catch (err) {
			record('GET /Users/{userId}/Items (Movie)', false, err.message);
		}

		try {
			const res = await request(`${JELLYFIN_URL}/Users/${userId}/Items/Resume?Limit=6`, { headers: authHeaders });
			const body = JSON.parse(res.body.toString('utf8') || '{}');
			record(
				'GET /Users/{userId}/Items/Resume',
				res.status === 200,
				`HTTP ${res.status}, TotalRecordCount=${body.TotalRecordCount} (0 is a valid empty state)`
			);
		} catch (err) {
			record('GET /Users/{userId}/Items/Resume', false, err.message);
		}

		const first = smokeItems.find((item) => item.ImageTags && item.ImageTags.Primary) || smokeItems[0];
		if (first) {
			const tag = first.ImageTags && first.ImageTags.Primary ? first.ImageTags.Primary : '';
			const url = `${JELLYFIN_URL}/Items/${first.Id}/Images/Primary?maxHeight=450${tag ? `&tag=${tag}` : ''}`;
			try {
				const res = await request(url, { headers: authHeaders });
				const contentType = res.headers['content-type'] || '';
				record(
					'GET /Items/{itemId}/Images/Primary',
					res.status === 200 && contentType.startsWith('image/') && res.body.length > 0,
					`HTTP ${res.status}, content-type=${contentType}, bytes=${res.body.length}`
				);
			} catch (err) {
				record('GET /Items/{itemId}/Images/Primary', false, err.message);
			}
		} else {
			warn('GET /Items/{itemId}/Images/Primary', 'no movie items available to test an image');
		}
	}

	// ------------------------------- Sunshine --------------------------------
	console.log(`\n== Sunshine (${SUNSHINE_URL}) ==`);

	if (!sunshineUser || !sunshinePass) {
		warn('Sunshine checks', 'SUNSHINE_USER/SUNSHINE_PASS not set; skipped');
	} else {
		const authHeader = `Basic ${Buffer.from(`${sunshineUser}:${sunshinePass}`).toString('base64')}`;
		const headers = { Authorization: authHeader, Accept: 'application/json' };

		try {
			const res = await request(`${SUNSHINE_URL}/api/apps`, { headers, insecure: true });
			const body = JSON.parse(res.body.toString('utf8') || '{}');
			const apps = body.apps || [];
			record(
				'GET /api/apps',
				res.status === 200 && Array.isArray(apps),
				`HTTP ${res.status}, apps=${apps.map((a) => a.name).join(', ')}`
			);
		} catch (err) {
			record('GET /api/apps', false, err.message);
		}

		try {
			const res = await request(`${SUNSHINE_URL}/api/config`, { headers, insecure: true });
			const body = JSON.parse(res.body.toString('utf8') || '{}');
			record(
				'GET /api/config',
				res.status === 200 && !!body.version,
				`HTTP ${res.status}, version=${body.version}, platform=${body.platform}`
			);
		} catch (err) {
			record('GET /api/config', false, err.message);
		}
	}

	// -------------------------------- Summary --------------------------------
	const failed = results.filter((r) => !r.ok);
	console.log('\n== Summary ==');
	console.log(`Total: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
	if (failed.length) {
		for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
		process.exitCode = 1;
	} else {
		console.log('ALL CHECKS PASSED');
	}
}

main().catch((err) => {
	console.error(`[FAIL] smoke test aborted: ${err.stack || err.message}`);
	process.exitCode = 1;
});
