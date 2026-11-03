import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_REF } from './backupCore.ts';
import { CONFIG_FILE } from './db.ts';

/**
 * The project's `supabase-backup.json`: its two Supabase projects. Committed, and holds no secrets (refs and names
 * show in every dashboard URL). Every check that tells production from dev reads it.
 */

export type Project = { ref: string; name: string };
export type Config = { production: Project; dev: Project };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(value: unknown, keys: string[], field: string): Record<string, unknown> {
	if (!isObject(value)) throw new Error(`${CONFIG_FILE}: ${field || 'the file'} must be an object`);
	const unknown = Object.keys(value).find((k) => !keys.includes(k));
	if (unknown !== undefined) {
		throw new Error(`${CONFIG_FILE}: unknown key ${field ? `${field}.` : ''}${unknown}`);
	}
	return value;
}

function project(value: unknown, field: string): Project {
	const { ref, name } = onlyKeys(value, ['ref', 'name'], field);
	if (typeof ref !== 'string' || !PROJECT_REF.test(ref)) {
		throw new Error(`${CONFIG_FILE}: ${field}.ref must be a 20-character project ref`);
	}
	if (typeof name !== 'string' || !name.trim()) {
		throw new Error(`${CONFIG_FILE}: ${field}.name must be a non-empty string`);
	}
	return { ref, name };
}

/** Validates a parsed config file, naming the first bad field. */
export function parseConfig(value: unknown): Config {
	const top = onlyKeys(value, ['projects'], '');
	const projects = onlyKeys(top.projects, ['production', 'dev'], 'projects');
	const config = {
		production: project(projects.production, 'projects.production'),
		dev: project(projects.dev, 'projects.dev')
	};
	if (config.production.ref === config.dev.ref) {
		throw new Error(`${CONFIG_FILE}: projects.production.ref and projects.dev.ref must differ`);
	}
	return config;
}

export function loadConfig(dir: string): Config {
	const path = join(dir, CONFIG_FILE);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`Could not read ${path}: ${String(error)}`);
	}
	return parseConfig(parsed);
}

export const configJSON = (config: Config) =>
	JSON.stringify({ projects: { production: config.production, dev: config.dev } }, null, '\t') +
	'\n';

/** `init`: validates the config and writes it, refusing to replace an existing file. */
export function writeConfig(dir: string, config: Config): string {
	const path = join(dir, CONFIG_FILE);
	if (existsSync(path)) throw new Error(`${path} already exists; edit it instead`);
	writeFileSync(path, configJSON(parseConfig({ projects: config })), { flag: 'wx' });
	return path;
}
