/** Unified-style line diff (LCS), enough for reviewing snapshot changes in a terminal or a PR body. */
export function lineDiff(before: string, after: string, context = 3): string {
	const a = before.split("\n");
	const b = after.split("\n");
	// lengths[i][j]: LCS length of a[i..] and b[j..]
	const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const ops: { kind: " " | "-" | "+"; line: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			ops.push({ kind: " ", line: a[i++] });
			j++;
		} else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
			ops.push({ kind: "-", line: a[i++] });
		} else {
			ops.push({ kind: "+", line: b[j++] });
		}
	}
	// Keep changed lines and `context` unchanged lines around them.
	const keep = ops.map((op, index) =>
		ops.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== " "),
	);
	const out: string[] = [];
	ops.forEach((op, index) => {
		if (keep[index]) out.push(`${op.kind}${op.line}`);
		else if (keep[index - 1]) out.push("…");
	});
	return out.join("\n");
}
