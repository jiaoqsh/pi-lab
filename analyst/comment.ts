// Turn an analyst output directory into a pull request comment: the summary, then each NOTES.md draft folded away.
//
//   node analyst/comment.ts <out-dir> > comment.md
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: comment.ts <analyst output directory>");

const drafts = readdirSync(dir)
	.filter((file) => file.endsWith(".md") && file !== "summary.md")
	.sort();
const parts = [
	"## Release analyst",
	"",
	readFileSync(join(dir, "summary.md"), "utf8").trim(),
	"",
	...drafts.flatMap((file) => [
		`<details><summary>Draft for <code>experiments/${file.replace(/\.md$/, "")}/NOTES.md</code></summary>`,
		"",
		readFileSync(join(dir, file), "utf8").trim(),
		"",
		"</details>",
		"",
	]),
	"---",
	"Written by the [release analyst](https://github.com/jiaoqsh/pi-lab/tree/main/analyst) (pi-durable + DeepSeek). Check quoted lines before updating NOTES.md.",
];
process.stdout.write(`${parts.join("\n")}\n`);
