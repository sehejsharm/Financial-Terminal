"use client";

import ReactMarkdown from "react-markdown";

/**
 * Terminal-styled markdown. Used for AI bull/bear + deep-analysis output.
 * Kept deliberately small — headings, lists, bold, and inline code only.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-txt space-y-3">
      <ReactMarkdown
        components={{
          h1: (p) => <h2 className="heading mt-4 mb-1" {...p} />,
          h2: (p) => <h3 className="text-amber font-bold uppercase tracking-wide text-xs mt-4 mb-1" {...p} />,
          h3: (p) => <h4 className="text-amber/90 font-bold text-xs mt-3 mb-1" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 space-y-1 marker:text-amber" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 space-y-1 marker:text-amber" {...p} />,
          strong: (p) => <strong className="text-white font-bold" {...p} />,
          code: (p) => <code className="text-amber bg-panel px-1 rounded text-[12px]" {...p} />,
          a: (p) => <a className="text-amber underline" {...p} />,
          p: (p) => <p className="text-txt/90" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
