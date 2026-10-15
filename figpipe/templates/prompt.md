Load the figma-batch skill (also at {skill}) and run batch {batch} in {mode} mode.

Manifest: {manifest}
It lists the lanes (one worktree per page area), the items, their extractions (node JSON, verbatim copy, renders, component sets with every state, threads, motion hints) and what earlier batches did.

Record each item as soon as it is settled with `figpipe record {batch} <part.json> --partial`. When done, run `figpipe result {batch}` and return its output unchanged as the final answer (it matches the manifest's result_schema).

These rules are also enforced by hooks; a denied call is listed in the report:
- Read Figma only through the REST read tools in the manifest's read_tools folder and the Figma MCP read tools. Never open figma.com, the Figma app or a browser.
- Before each Figma MCP call, run `figpipe budget mcp --batch {batch}` and stop calling MCP when it answers no.
- Never push, open pull requests, message anyone, or write to Figma or a CMS.
- Edit only inside the lane worktrees, the batch folder and the extract folder. Commit locally, one commit per item.
