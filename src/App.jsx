// src/App.jsx
import { useEffect, useMemo, useState } from "react";

/** ====== 環境變數 ====== */
const CONFIG = {
  DATA_URL: import.meta.env.VITE_DATA_URL,        // Apps Script 的 exec URL（或 echo，會自動 JSONP 後援）
  CLIENT_ID: import.meta.env.VITE_CLIENT_ID,      // OAuth Web client ID
  PAGE_SIZE: 50,
};

console.log("[env check]", CONFIG.DATA_URL, CONFIG.CLIENT_ID);

/** ====== 欄位定義 ====== */
const columns = [
  { key: "Plasmid_Name", label: "Plasmid" },
  { key: "Plasmid_Information", label: "Info" },
  { key: "Antibiotics", label: "Abx" },
  { key: "Descriptions", label: "Description" },
  { key: "Box_(Location)", label: "Box" },
  { key: "Benchling", label: "Benchling" },
];

/** JSONP 後援（遇到 googleusercontent 的 echo 端點時使用） */
function fetchJSONP(url) {
  return new Promise((resolve, reject) => {
    const cb = "__jsonp_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");

    window[cb] = (data) => {
      try { resolve(data); }
      finally {
        delete window[cb];
        script.remove();
      }
    };

    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    script.onerror = () => {
      delete window[cb];
      script.remove();
      reject(new Error("JSONP load error"));
    };

    document.body.appendChild(script);
  });
}

export default function App() {
  // 資料/狀態
  const [data, setData] = useState({ members: [], rows: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 登入相關
  const [idToken, setIdToken] = useState(null);
  const [authEmail, setAuthEmail] = useState("");

  // UI 狀態
  const [q, setQ] = useState("");
  const [member, setMember] = useState("all");
  const [worksheet, setWorksheet] = useState("all");
  const [sortKey, setSortKey] = useState("Plasmid_Name");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(1);

  /** ====== 初始化 Google Identity，取得 idToken ====== */
  useEffect(() => {
    function init() {
      /* global google */
      if (!window.google || !google.accounts?.id) return;

      google.accounts.id.initialize({
        client_id: CONFIG.CLIENT_ID,
        callback: (resp) => {
          if (!resp?.credential) return;
          setIdToken(resp.credential);
          window.__IDTOKEN__ = resp.credential;
          console.log("[GIS] got idToken:", !!resp.credential);
          try {
            const payload = JSON.parse(atob(resp.credential.split(".")[1]));
            setAuthEmail(payload?.email || "");
          } catch {}
        },
      });

      // One Tap；若被擋，會在備用按鈕渲染
      google.accounts.id.prompt();
      const el = document.getElementById("signin-btn");
      if (el) google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
    }

    if (document.readyState === "complete") init();
    else window.addEventListener("load", init);
    return () => window.removeEventListener("load", init);
  }, []);

  /** ====== 取得資料：等拿到 idToken 再抓，並在 URL 帶上 ?idToken= ====== */
  useEffect(() => {
    if (!idToken) return; // 還沒登入完成，先不要發請求

    let alive = true;
    (async () => {
      try {
        setLoading(true);

        const base = CONFIG.DATA_URL;
        const url =
          base +
          (base.includes("?") ? "&" : "?") +
          "idToken=" +
          encodeURIComponent(idToken); // 帶上 token

        let json;
        try {
          // 先試標準 fetch（exec URL 會成功）
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          json = await res.json();
        } catch (err) {
          // 若是 echo 端點（無 CORS）→ 用 JSONP 後援
          if (String(base).includes("script.googleusercontent.com/macros/echo")) {
            json = await fetchJSONP(url);
          } else {
            throw err;
          }
        }

        if (json.error) throw new Error(json.error + (json.reason ? ": " + json.reason : ""));

        const rows = (json.rows || []).map((r) => ({
          ...r,
          Benchling: normalizeBenchling(r.Benchling),
        }));
        if (!alive) return;
        setData({ members: json.members || [], rows, updatedAt: json.updatedAt || null });
        setError("");
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [idToken]);

  // 切換 member 時重置 worksheet 與頁碼
  useEffect(() => {
    setWorksheet("all");
    setPage(1);
  }, [member]);

  /** ====== Member 選項（顯示 "10 · YiFeng"） ====== */
  const memberOptions = useMemo(() => {
    const arr = data.members.map((m) => ({
      value: m.memberId || m.name,
      label: [m.memberId, m.name].filter(Boolean).join(" · "),
    }));
    arr.sort((a, b) => naturalCompare(a.label, b.label));
    return ["all", ...arr];
  }, [data.members]);

  /** ====== Worksheet 選項（列出所有 tab；選了 member 就列該 member 的 tabs） ====== */
  const worksheetOptions = useMemo(() => {
    if (member === "all") {
      const set = new Set();
      data.members.forEach((m) => (m.worksheets || []).forEach((ws) => set.add(ws)));
      return ["all", ...Array.from(set).sort(naturalCompare)];
    }
    const m = data.members.find((x) => x.memberId === member || x.name === member);
    const ws = (m && m.worksheets) || [];
    return ["all", ...ws.slice().sort(naturalCompare)];
  }, [member, data.members]);

  /** ====== 篩選 + 多關鍵字(AND) 搜尋 + 排序 ====== */
  const filtered = useMemo(() => {
    const needles = q.toLowerCase().split(/\s+/).filter(Boolean);
    const xs = data.rows.filter((r) => {
      if (member !== "all" && !(r.memberId === member || r.memberName === member)) return false;
      if (worksheet !== "all" && r.worksheet !== worksheet) return false;
      if (needles.length === 0) return true;

      const bench = typeof r.Benchling === "string"
        ? r.Benchling
        : (r.Benchling && (r.Benchling.url || r.Benchling.text)) || "";

      const hay = [
        r.Plasmid_Name, r.Plasmid_Information, r.Antibiotics,
        r.Descriptions, r["Box_(Location)"], bench,
      ].filter(Boolean).join(" ").toLowerCase();

      return needles.every((n) => hay.includes(n)); // AND
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
    else { setSortKey(key); setSortDir("asc"); }
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
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
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
            options={memberOptions}
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
              const v = (typeof opt === 'string' ? opt : opt.value);
              const [k, d] = String(v).split(":");
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
            {error ? <span style={{ color: "#b91c1c", fontSize: 14 }}>{error}</span> : null}
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
                      {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
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
                      <td style={{ ...styles.td, textAlign: "right", whiteSpace: "nowrap", fontSize: 12, color: "#6b7280" }}>
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
              {total > 0 ? " · Showing " + (start + 1) + "–" + Math.min(total, start + CONFIG.PAGE_SIZE) : ""}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={styles.btn} disabled={page <= 1} onClick={() => setPage(1)}>First</button>
              <button style={styles.btn} disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>Prev</button>
              <button style={styles.btn} disabled={page >= pageCount} onClick={() => setPage(Math.min(pageCount, page + 1))}>Next</button>
              <button style={styles.btn} disabled={page >= pageCount} onClick={() => setPage(pageCount)}>Last</button>
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

/** ====== 小元件：Select（支援字串或 {value,label}） ====== */
function Select({ label, value, onChange, options, renderOption }) {
  const norm = (opt) => (typeof opt === 'string' ? { value: opt, label: opt } : opt);
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: 14, gap: 4 }}>
      <span style={{ color: "#374151" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 8px", fontSize: 14 }}
      >
        {options.map((opt) => {
          const o = norm(opt);
          return (
            <option key={o.value} value={o.value}>
              {renderOption ? renderOption(o) : o.label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/** ====== helpers ====== */
function renderCell(key, row) {
  const v = row[key];
  if (key === "Descriptions") {
    return <span style={{ display: "block", maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis" }}>{String(v || "")}</span>;
  }
  if (key === "Benchling") {
    const url = typeof v === "string" ? v : v && v.url;
    const text = typeof v === "string" ? shortUrl(v) : v && (v.text || shortUrl(v.url || ""));
    if (!url) return null;
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ color: "#166534", textDecoration: "underline", wordBreak: "break-all" }}>
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
  } catch { return String(u || ""); }
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

/** ====== inline styles ====== */
const styles = {
  page: { minHeight: "100vh", background: "#f9fafb", color: "#111827" },
  header: {
    position: "sticky", top: 0, zIndex: 10, background: "rgba(255,255,255,0.9)",
    borderBottom: "1px solid #e5e7eb", padding: "10px 16px", display: "flex",
    gap: 12, alignItems: "center", justifyContent: "space-between", backdropFilter: "saturate(180%) blur(6px)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  logo: { width: 36, height: 36, borderRadius: 10, background: "#16a34a", color: "white",
          display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 },
  title: { fontSize: 18, fontWeight: 600 },
  subtitle: { fontSize: 12, color: "#6b7280" },
  search: { width: "100%", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 10px", fontSize: 14,
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)" },
  main: { maxWidth: 1120, margin: "0 auto", padding: 16 },
  filters: { display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 12 },
  card: { background: "white", border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)" },
  cardTop: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #e5e7eb" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 12px", whiteSpace: "nowrap", cursor: "pointer" },
  td: { padding: "10px 12px", verticalAlign: "top" },
  empty: { padding: "32px 12px", textAlign: "center", color: "#6b7280" },
  cardBottom: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderTop: "1px solid #e5e7eb", fontSize: 14 },
  btn: { border: "1px solid #e5e7eb", background: "white", padding: "6px 10px", borderRadius: 8, cursor: "pointer" },
};

// 小螢幕排版（純 CSS）
if (typeof document !== "undefined") {
  const css = `@media (min-width: 640px) { .filters { grid-template-columns: repeat(3, 1fr) !important; } }`;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}
