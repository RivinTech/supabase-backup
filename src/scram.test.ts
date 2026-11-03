import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { scramVerifier } from './scram.ts';

// RFC 7677 section 3: user "user", password "pencil". A server holding only the verifier must accept the RFC's
// client proof and produce the RFC's server signature, which proves StoredKey and ServerKey are right.
const SALT = 'W22ZaJ0SNY7soEsUEjb6gQ==';
const NONCE = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const AUTH_MESSAGE = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${NONCE},s=${SALT},i=4096,c=biws,r=${NONCE}`;
const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

test('scramVerifier matches the RFC 7677 example', () => {
	const verifier = scramVerifier('pencil', Buffer.from(SALT, 'base64'));
	const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
	assert.ok(match, verifier);
	const [, salt, storedKey, serverKey] = match;
	assert.equal(salt, SALT);

	const hmac = (key: Buffer) => createHmac('sha256', key).update(AUTH_MESSAGE).digest();
	const clientSignature = hmac(Buffer.from(storedKey!, 'base64'));
	const clientKey = Buffer.from(CLIENT_PROOF, 'base64').map(
		(byte, i) => byte ^ clientSignature[i]!
	);
	assert.equal(createHash('sha256').update(clientKey).digest('base64'), storedKey);
	assert.equal(hmac(Buffer.from(serverKey!, 'base64')).toString('base64'), SERVER_SIGNATURE);
});
