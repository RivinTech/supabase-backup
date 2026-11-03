import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';

/**
 * A Postgres SCRAM-SHA-256 password verifier (RFC 5802 and RFC 7677), the form `alter role ... password` accepts
 * without ever seeing the password: `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, all base64.
 *
 * Postgres SASLprep-normalizes passwords first; callers pass ASCII-only passwords, for which that is the identity.
 */
export function scramVerifier(password: string, salt: Buffer, iterations = 4096): string {
	const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	const storedKey = createHash('sha256').update(clientKey).digest();
	const serverKey = createHmac('sha256', salted).update('Server Key').digest();
	const b64 = (b: Buffer) => b.toString('base64');
	return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
