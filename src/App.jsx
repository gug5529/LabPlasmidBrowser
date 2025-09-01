import { useEffect, useMemo, useState } from "react";

/** ====== 環境變數設定 ====== */
const CONFIG = {
  DATA_URL: import.meta.env.VITE_DATA_URL,        // googleusercontent 最終 URL
  CLIENT_ID: import.meta.env.VITE_CLIENT_ID,      // 你的 OAuth Web client ID
  PAGE_SIZE: 50,
};

/** ====== 欄位定義（依你的表頭） ====== */
const columns = [
  { key: "Plasmid_Name", label: "Plasmid" },
  { key: "Plasmid_Information", label: "Info" },
  { key: "Antibiotics", label: "Abx" },
  { key: "Descriptions", label: "Description" },
  { key: "Box_(Location)", label: "Box" },
  { key: "Benchling", label: "Benchling" },
];

export default function App() {
  const [data, setData] = useState({ members: [], rows: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // login & env
  const [idToken, setIdToken] = useState(null);
  const [authEmail, setAuthEmail] = useState("");

  // filters / ui state
  const [q, setQ] = useState("");
  const [member, setMember] = useState("all");
  const [worksheet, setWorksheet] = useState("all");
  const [sortKey, setSortKey] = useState("Plasmid_Name");
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const [page, setPage] = useState(1);

  /** ====== 初始化 Google Identity，取得 idToken ====== */
  useEffect(() => {
    function init() {
      /* global google */
      if (!window.google || !google.accounts?.id) return;

      google.accounts.id.initialize({
        client_id: CONFIG.CLIENT_ID,
        callback: (resp) => {
          setIdToken(resp.credential);
          try {
            const payload = JSON.parse(atob(resp.credential.split(".")[1]));
            setAuthEmail(payload?.email || "");
          } catch {}
          console.log("[GIS] got idToken:", !!resp.credential);
        },
      });

      // 顯示 One Tap；如果被擋，會在下方 #signin-btn 渲染備用按鈕
      google.accounts.id.prompt();

      const el = document.getElementById("signin-btn");
      if (el) google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
    }

    if (document.readyState === "complete") init();
    else window.addEventListener("load", init);
    return () => window.removeEventListener("load", init);
  }, []);

  /** ====== 抓資料（等拿到 idToken 再抓，並在 URL 夾帶 idToken） ====== */
  useEffect(() => {
    if (!idToken) return; // 尚未登入，不抓

    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const url =
          CONFIG.DATA_URL +
          (CONFIG.DATA_URL.includes("?") ? "&" : "?") +
          "idToken=" +
          encodeURIComponent(idToken);

        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        if (json.error)
          throw new Error(json.error + (json.reason ? ": " + json.reason : ""));

        const rows = (json.rows || []).map((r) => ({
          ...r,
          Benchling: normalizeBenchling(r.Benchling),
        }));

        if (!alive) return;
        setData({
          members: json.members || [],
          rows,
          updatedAt: json.updatedAt || null,
        });
        setError("");
      } catch (e) {
        if (!alive) return;
        setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [idToken]);

  // 當 member 改變時重置 worksheet
  useEffect(() => {
    setWorksheet("all");
    setPage(1);
  }, [member]);

  // Worksheet 下拉選單的選項
  const worksheetOptions = useMemo(() => {
    if (member === "all") {
      const set = new Set(data.rows.map((r) => r.worksheet).filter(Boolean));
      return ["all", ...Array.from(set).sort()];
    }
    const m = data.members.find(
      (x) => x.memberId === member || x.name === member
    );
    const ws = (m && m.worksheets) || [];
    return ["all", ...ws.slice().sort()];
  }, [member, data.members, data.rows]);

  /** ====== 篩選 + 多關鍵字(AND) 搜尋 + 排序 ====== */
  const filtered = useMemo(() => {
    const needles = q.toLowerCase().split(/\s+/).filter(Boolean);
    const base = data.rows;

    const xs = base.filter((r) => {
      if (member !== "all" && !(r.memberId === member || r.memberName === member))
        return false;
      if (worksheet !== "all" && r.worksheet !== worksheet) return false;
      if (needles.length === 0) return true;

      const bench =
        typeof r.Benchling === "string"
          ? r.Benchling
          : (r.Benchling && (r.Benchling.url || r.Benchling.text)) || "";

      const haystack = [
        r.Plasmid_Name,
        r.Plasmid_Information,
        r.Antibiotics,
        r.Descriptions,
        r["Box_(Location)"],
        bench,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return needles.every((n) => haystack.includes(n)); // AND
    });

    xs.sort((a, b) => {
      const av = String(a[sortKey] ?? "").toLowerCase();
      const bv = String(b[sortKey] ?? "").toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return xs;
  }, [q, data.rows, member, worksheet, sortKey, sortDir]);

  // 分頁
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  const start = (page - 1) * CONFIG.PAGE_SIZE;
  const pageRows = filtered.slice(start, start + CONFIG.PAGE_SIZE);

  function changeSort(key) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>PB</div>
          <div>
            <div style={styles.title}>Plasmid Browser</div>
            <div style={styles.subtitle}>
              {data.updatedAt ? "Updated: " + new Date(data.updatedAt).toLocaleString() : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 360, maxWidth: "54vw" }}>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search: e.g. NRC4 mCherry, kan, box A1…"
              style={styles.search}
            />
          </div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {authEmail ? `Signed in: ${authEmail}` : <div id="signin-btn" />}
          </div>
        </div>
      </header>

      {!idToken ? (
        <div style={{ padding: 16 }}>請先使用 Google 帳號登入（Workspace 或白名單 Gmail）。</div>
      ) : null}

      <main style={styles.main}>
        {/* Filters */}
        <div className="filters" style={styles.filters}>
          <Select
            label="Member"
            value={member}
            onChange={setMember}
            options={["all", ...data.members.map((m) => m.memberId || m.name).sort(naturalCompare)]}
          />
          <Select
            label="Worksheet"
            value={worksheet}
            onChange={setWorksheet}
            options={worksheetOptions}
          />
          <Select
            label="Sort"
            value={sortKey + ":" + sortDir}
            onChange={(v) => {
              const [k, d] = String(v).split(":");
              setSortKey(k);
              setSortDir(d || "asc");
            }}
            options={columns.flatMap((c) => [c.key + ":asc", c.key + ":desc"])}
            renderOption={(opt) => {
              const [k, d] = String(opt).split(":");
              const col = columns.find((c) => c.key === k);
              return (col ? col.label : k) + " (" + (d || "asc") + ")";
            }}
          />
        </div>

        {/* Table */}
        <div style={styles.card}>
          <div style={styles.cardTop}>
            <span style={{ color: "#4b5563", fontSize: 14 }}>
              {loading ? "Loading…" : total + " result" + (total === 1 ? "" : "s")}
            </span>
            {error ? (
              <span style={{ color: "#b91c1c", fontSize: 14 }}>{error}</span>
            ) : null}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead style={{ background: "#f3f4f6" }}>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      style={styles.th}
                      onClick={() => changeSort(c.key)}
                      title="Click to sort"
                    >
                      {c.label}
                      {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                  <th style={{ ...styles.th, textAlign: "right" }}>Member / Sheet</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={columns.length + 1} style={styles.empty}>
                      No matches. Try a different keyword or filter.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 ? "#ffffff" : "#fafafa" }}>
                      {columns.map((c) => (
                        <td key={c.key} style={styles.td}>
                          {renderCell(c.key, r)}
                        </td>
                      ))}
                      <td
                        style={{
                          ...styles.td,
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          fontSize: 12,
                          color: "#6b7280",
                        }}
                      >
                        {(r.memberId || r.memberName) + " · " + (r.worksheet || "")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={styles.cardBottom}>
            <div>
              Page {page} / {pageCount}{" "}
              {total > 0
                ? " · Showing " +
                  (start + 1) +
                  "–" +
                  Math.min(total, start + CONFIG.PAGE_SIZE)
                : ""}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={styles.btn} disabled={page <= 1} onClick={() => setPage(1)}>
                First
              </button>
              <button
                style={styles.btn}
                disabled={page <= 1}
                onClick={() => setPage(Math.max(1, page - 1))}
              >
                Prev
              </button>
              <button
                style={styles.btn}
                disabled={page >= pageCount}
                onClick={() => setPage(Math.min(pageCount, page + 1))}
              >
                Next
              </button>
              <button style={styles.btn} disabled={page >= pageCount} onClick={() => setPage(pageCount)}>
                Last
              </button>
            </div>
          </div>
        </div>

        <p style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          Tip: On mobile, swipe the table left/right to see all columns. Tap a column header to sort.
        </p>
      </main>
    </div>
  );
}

/** ====== 小元件：下拉選單 ====== */
function Select({ label, value, onChange, options, renderOption }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: 14, gap: 4 }}>
      <span style={{ color: "#374151" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          border: "1px solid #d1d5db",
          borderRadius: 8,
          padding: "6px 8px",
          fontSize: 14,
        }}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {renderOption ? renderOption(opt) : opt}
          </option>
        ))}
      </select>
    </label>
  );
}

/** ====== helpers ====== */
function renderCell(key, row) {
  const v = row[key];
  if (key === "Descriptions") {
    return (
      <span style={{ display: "block", maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis" }}>
        {String(v || "")}
      </span>
    );
  }
  if (key === "Benchling") {
    const url = typeof v === "string" ? v : v && v.url;
    const text =
      typeof v === "string" ? shortUrl(v) : v && (v.text || shortUrl(v.url || ""));
    if (!url) return null;
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ color: "#166534", textDecoration: "underline", wordBreak: "break-all" }}
      >
        {text}
      </a>
    );
  }
  return <span>{String(v || "")}</span>;
}

function shortUrl(u) {
  try {
    const x = new URL(String(u || ""));
    return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "");
  } catch {
    return String(u || "");
  }
}
function normalizeBenchling(b) {
  if (!b) return null;
  if (typeof b === "string") return b;
  if (typeof b === "object" && (b.url || b.text)) return b;
  return null;
}
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** ====== inline styles（避免額外依賴） ====== */
const styles = {
  page: { minHeight: "100vh", background: "#f9fafb", color: "#111827" },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "rgba(255,255,255,0.9)",
    borderBottom: "1px solid #e5e7eb",
    padding: "10px 16px",
    display: "flex",
    gap: 12,
    alignItems: "center",
    justifyContent: "space-between",
    backdropFilter: "saturate(180%) blur(6px)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: "#16a34a",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
  },
  title: { fontSize: 18, fontWeight: 600 },
  subtitle: { fontSize: 12, color: "#6b7280" },
  search: {
    width: "100%",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 14,
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },
  main: { maxWidth: 1120, margin: "0 auto", padding: 16 },
  filters: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 8,
    marginBottom: 12,
  },
  card: {
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #e5e7eb",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 12px", whiteSpace: "nowrap", cursor: "pointer" },
  td: { padding: "10px 12px", verticalAlign: "top" },
  empty: { padding: "32px 12px", textAlign: "center", color: "#6b7280" },
  cardBottom: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderTop: "1px solid #e5e7eb",
    fontSize: 14,
  },
  btn: {
    border: "1px solid #e5e7eb",
    background: "white",
    padding: "6px 10px",
    borderRadius: 8,
    cursor: "pointer",
  },
};

// 小螢幕排版（純 CSS）
if (typeof document !== "undefined") {
  const css = `
  @media (min-width: 640px) {
    .filters { grid-template-columns: repeat(3, 1fr) !important; }
  }`;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}