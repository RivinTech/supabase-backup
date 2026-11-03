/**
 * The CLI stores a migration as its statements, each trimmed and without the closing `;`. Joining
 * them with `;` and normalizing both sides the same way (whitespace runs to one space, no space
 * around `;`, no final `;`) leaves every edit but whitespace, inside string literals and function
 * bodies too. The one miss is a whitespace-only change inside a literal (verified: doubling a space
 * in an error message passes). Such a change alters the literal's value, but catching it would take
 * a SQL tokenizer, and the drift it would hide is an edited file whose only change is a literal's
 * spacing.
 */
export const comparable = (sql: string) =>
	sql
		.replace(/\s+/g, ' ')
		.replace(/ ?; ?/g, ';')
		.replace(/;?\s*$/, '')
		.trim();
