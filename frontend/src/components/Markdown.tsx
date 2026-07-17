"use client";

import ReactMarkdown from "react-markdown";

/**
 * Terminal-styled markdown. Used for AI bull/bear + deep-analysis output.
 * Kept deliberately small — headings, lists, bold, and inline code only.
 */
/** LLMs often emit a closing sentence directly under a bullet list with no
 *  blank line; CommonMark "lazy continuation" then glues it onto the last
 *  bullet. Insert the missing blank line so it renders as its own paragraph. */
function unglueLists(md: string): string {
  const bullet = /^\s*(?:[-*+]|\d+[.)])\s/;
  const lines = md.split("\n");
  const out: string[] = [];
  for (const cur of lines) {
    const prev = out.length ? out[out.length - 1] : "";
    if (bullet.test(prev) && cur.trim() !== "" && !bullet.test(cur)) out.push("");
    out.push(cur);
  }
  return out.join("\n");
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-txt space-y-3">
      <ReactMarkdown
        components={{
          h1: (p) => <h2 className="heading mt-4 mb-1" {...p} />,
          h2: (p) => <h3 className="text-amber font-bold uppercase tracking-wide text-xs mt-4 mb-1" {...p} />,
          h3: (p) => <h4 className="text-amber/90 font-bold text-xs mt-3 mb-1" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 my-2 space-y-1 marker:text-amber" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 my-2 space-y-1 marker:text-amber" {...p} />,
          strong: (p) => <strong className="text-white font-bold" {...p} />,
          code: (p) => <code className="text-amber bg-panel px-1 rounded text-[12px]" {...p} />,
          a: (p) => <a className="text-amber underline" {...p} />,
          p: (p) => <p className="text-txt/90" {...p} />,
        }}
      >
        {unglueLists(children)}
      </ReactMarkdown>
    </div>
  );
}
