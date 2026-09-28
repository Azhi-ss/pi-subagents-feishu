/** Await detached work without letting the test process exit before its result. */
export async function withReferencedDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		// Production observers/backstops deliberately unref their handles; the
		// test owns this bounded wait rather than changing that runtime contract.
		timer = setTimeout(() => reject(new Error(`Detached test work did not settle within ${timeoutMs}ms.`)), timeoutMs);
	});
	try {
		return await Promise.race([pending, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
