"use client";

/** Last-resort boundary: catches crashes in the root layout itself. Must
 *  render its own <html>/<body> because the layout is gone at this point. */
export default function GlobalError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#0c0e12", color: "#dfe3ea",
                     fontFamily: "monospace", display: "flex",
                     alignItems: "center", justifyContent: "center",
                     minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <div style={{ color: "#ff4d4f", marginBottom: 12, letterSpacing: 2 }}>
            MOTHERBOARD TERMINAL CRASHED
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>
            {error?.message || "Unexpected error."}
          </div>
          <button onClick={reset}
                  style={{ background: "#ffb000", color: "#0c0e12", border: 0,
                           padding: "8px 16px", cursor: "pointer",
                           fontFamily: "inherit", fontWeight: 700 }}>
            RELOAD
          </button>
        </div>
      </body>
    </html>
  );
}
