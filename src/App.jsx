import { useEffect, useMemo, useState } from "react";

const CONFIG = {
  DATA_URL: import.meta.env.VITE_DATA_URL,
  CLIENT_ID: import.meta.env.VITE_CLIENT_ID,
  PAGE_SIZE: 50,
};

const columns = [
  { key: "Plasmid_Name", label: "Plasmid" },
  { key: "Plasmid_Information", label: "Info" },
  { key: "Antibiotics", label: "Abx" },
  { key: "Descriptions", label: "Description" },
  { key: "Box_(Location)", label: "Box" },
  { key: "Benchling", label: "Benchling" },
];

/** echo 端點的 JSONP 後援 */
function fetchJSONP(url) {
  return new Promise((resolve, reject) => {
    const cb = "__jsonp_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    window[cb] = (data) => { try { resolve(data); } finally { delete window[cb]; script.remove(); } };
    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    script.onerror = () => { delete window[cb]; script.remove(); reject(new Error("JSONP load error")); };
    document.body.appendChild(script);
  });
}

/** 是否為 all_plasmids（大小寫/底線/空白/符號不敏感） */
function isAllPlasmids(name) {
  const s = String(name || "").toLowerCase().replace(/\u00A0/g, " ").replace(/[^a-z0-9]+/g, "");
  return s === "allplasmids" || s === "allplasmid";
}

/** 是否屬於 Level 0/1/2（用於判斷 Other） */
function isLevel012(name) {
  const raw = String(name || "").toLowerCase();
  return (
    /(^|[^a-z])(l|lvl|lv|level)[ _-]*0([^a-z]|$)/.test(raw) ||
    /(^|[^a-z])(l|lvl|lv|level)[ _-]*1([^a-z]|$)/.test(raw) ||
    /(^|[^a-z])(l|lvl|lv|level)[ _-]*2([^a-z]|$)/.test(raw)
  );
}

export default function App() {
  const [data, setData] = useState({ members: [], rows: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [idToken, setIdToken] = useState(null);
  const [authEmail, setAuthEmail] = useState("");

  const [q, setQ] = useState("");
  const [member, setMember] = useState("all");
  const [group, setGroup] = useState("all"); // 只有 all / Other
  const [worksheet, setWorksheet] = useState("all");
  const [sortKey, setSortKey] = useState("Plasmid_Name");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(1);

  /** Google Identity 初始化 */
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
          try {
            setAuthEmail(JSON.parse(atob(resp.credential.split(".")[1]))?.email || "");
          } catch {}
        },
      });

      google.accounts.id.prompt();
      const el = document.getElementById("signin-btn");
      if (el) google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
    }

    if (document.readyState === "complete") init();
    else window.addEventListener("load", init);
    return () => window.removeEventListener("load", init);
  }, []);

  /** 抓資料（fetch 失敗 → 自動 JSONP 後援） */
  useEffect(() => {
    if (!idToken) return;

    let alive = true;
    (async () => {
      try {
        setLoading(true);

        const base = CONFIG.DATA_URL;
        const url =
          base + (base.includes("?") ? "&" : "?") + "idToken=" + encodeURIComponent(idToken);

        let json;
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          json = await res.json();
        } catch (err) {
          json = await fetchJSONP(url);
        }

        if (json.error) throw new Error(json.error + (json.reason ? ": " + json.reason : ""));

        const rows = (json.rows || [])
          .filter((r) => !isAllPlasmids(r.worksheet))
          .map((r) => ({
            ...r,
            wsIsOther: !isLevel012(r.worksheet),
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

  useEffect(() => {
    setWorksheet("all");
    setPage(1);
  }, [member, group]);

  /** Member 選項（顯示「10 · YiFeng」） */
  const memberOptions = useMemo(() => {
    const arr = data.members.map((m) => ({
      value: m.memberId || m.name,
      label: [m.memberId, m.name].filter(Boolean).join(" · "),
    }));
    arr.sort((a, b) => naturalCompare(a.label, b.label));
    return ["all", ...arr];
  }, [data.members]);

  /** Group 選項：只有 all / Other（沒 Other 就只顯示 all） */
  const groupOptions = useMemo(() => {
    const hasOther = (data.rows || []).some((r) => r.wsIsOther);
    return hasOther ? ["all", "Other"] : ["all"];
  }, [data.rows]);

  /** Worksheet 選項：依 member + group 篩後蒐集 */
  const worksheetOptions = useMemo(() => {
    let pool = data.rows;
    if (member !== "all")
      pool = pool.filter((r) => r.memberId === member || r.memberName === member);
    if (group === "Other") pool = pool.filter((r) => r.wsIsOther === true);
    const set = new Set(pool.map((r) => r.worksheet).filter(Boolean));
    return ["all", ...Array.from(set).sort(naturalCompare)];
  }, [member, group, data.rows]);

  /** 篩選 + 排序 + 搜尋 */
  const filtered = useMemo(() => {
    const needles = q.toLowerCase().split(/\s+/).filter(Boolean);
    const xs = data.rows.filter((r) => {
      if (member !== "all" && !(r.memberId === member || r.memberName === member)) return false;
      if (group === "Other" && !r.wsIsOther) return false;
      if (worksheet !== "all" && r.worksheet !== worksheet) return false;

      if (needles.length === 0) return true;

      const bench =
        typeof r.Benchling === "string"
          ? r.Benchling
          : (r.Benchling && (r.Benchling.url || r.Benchling.text)) || "";

      const hay = [
        r.Plasmid_Name,
        r.Plasmid_Information,
        r.Antibiotics,
        r.Descriptions,
        r["Box_(Location)"],
        bench,
        r.memberId,
        r.memberName,
        r.worksheet,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return needles.every((n) => hay.includes(n));
    });

    xs.sort((a, b) => {
      const av = String(a[sortKey] ?? "").toLowerCase();
      const bv = String(b[sortKey] ?? "").toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return xs;
  }, [q, data.rows, member, group, worksheet, sortKey, sortDir]);

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
      {/* Header：logo + (title / search / updated)，右側登入狀態 */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo} aria-hidden="true" />
          <div>
            <div style={styles.title}>Plasmid Browser</div>
            <div style={{ marginTop: 6 }}>
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="keyword search"
                style={styles.search}
              />
            </div>
            {data.updatedAt ? (
              <div style={styles.subtitle}>
                Updated: {new Date(data.updatedAt).toLocaleString()}
              </div>
            ) : null}
          </div>
        </div>
        <div style={styles.signedIn}>
          {authEmail ? `Signed in: ${authEmail}` : <div id="signin-btn" />}
        </div>
      </header>

      {!idToken ? (
        <div style={{ padding: 16 }}>
          請先使用 Google 帳號登入（Workspace 或白名單 Gmail）。
        </div>
      ) : null}

      <main style={styles.main}>
        {/* Controls：兩欄（手機自動 1 欄） */}
        <div className="controls" style={styles.controls}>
          <div style={styles.controlCol}>
            <Select label="Member" value={member} onChange={setMember} options={memberOptions} />
            <Select
              label="Worksheet"
              value={worksheet}
              onChange={setWorksheet}
              options={worksheetOptions}
            />
          </div>
          <div style={styles.controlCol}>
            <Select label="Group" value={group} onChange={setGroup} options={groupOptions} />
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
                const v = typeof opt === "string" ? opt : opt.value;
                const [k, d] = String(v).split(":");
                const col = columns.find((c) => c.key === k);
                return (col ? col.label : k) + " (" + (d || "asc") + ")";
              }}
            />
          </div>
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
              <button
                style={styles.btn}
                disabled={page >= pageCount}
                onClick={() => setPage(pageCount)}
              >
                Last
              </button>
            </div>
          </div>
        </div>

        <p style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          Tip: 「Group → Other」會只顯示非 Level 0/1/2 的工作表；<code>all_plasmids</code> 已自動忽略。
        </p>
      </main>
    </div>
  );
}

/** Select（支援字串或 {value,label}） */
function Select({ label, value, onChange, options, renderOption }) {
  const norm = (opt) => (typeof opt === "string" ? { value: opt, label: opt } : opt);
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

/** Cell renderers */
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
    if (!url) {
      return <span style={styles.noData}>no data</span>;
    }
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-label="Open Benchling link" style={styles.linkBtn}>
        link here
      </a>
    );
  }

  return <span>{String(v || "")}</span>;
}

/** helpers */
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

/** styles */
const styles = {
  page: { minHeight: "100vh", background: "#f9fafb", color: "#111827" },

  // Header：左 logo、右邊堆疊 title + search + updated
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "rgba(255,255,255,0.95)",
    borderBottom: "1px solid #e5e7eb",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backdropFilter: "saturate(180%) blur(6px)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { width: 48, height: 48, borderRadius: 6, background: "#16a34a", border: "3px solid #0f5132" },
  title: { fontSize: 18, fontWeight: 700 },
  subtitle: { marginTop: 6, fontSize: 12, color: "#6b7280" },
  signedIn: { fontSize: 12, color: "#6b7280", display: "flex", alignItems: "center" },

  // 搜尋框（header 內）
  search: {
    width: "min(64vw, 420px)",
    border: "2px solid #111827",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
    background: "#e5e7eb",
  },

 controls: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))", // ← 兩欄（每欄 1/2 寬）
    gap: 8,
    marginBottom: 12,
  },
  controlCol: { display: "grid", gridTemplateRows: "auto auto", gap: 8 },

  main: { maxWidth: 1120, margin: "0 auto", padding: 16 },

  card: {
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  cardTop: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #e5e7eb" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 12px", whiteSpace: "nowrap", cursor: "pointer" },
  td: { padding: "10px 12px", verticalAlign: "top" },
  empty: { padding: "32px 12px", textAlign: "center", color: "#6b7280" },
  cardBottom: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderTop: "1px solid #e5e7eb", fontSize: 14 },
  btn: { border: "1px solid #e5e7eb", background: "white", padding: "6px 10px", borderRadius: 8, cursor: "pointer" },

  // Benchling 欄的按鈕與空值
  linkBtn: {
    display: "inline-block",
    border: "1px solid #e5e7eb",
    padding: "4px 8px",
    borderRadius: 8,
    textDecoration: "none",
    fontSize: 12,
    lineHeight: "16px",
    color: "#166534",
    background: "#f0fdf4",
    whiteSpace: "nowrap",
  },
  noData: { color: "#9ca3af", fontStyle: "italic", fontSize: 12 },
};

// RWD：>=640px 時把 controls 變成兩欄
if (typeof document !== "undefined") {
  const css = `
    @media (min-width: 640px) {
      .controls { grid-template-columns: 1fr 1fr !important; }
    }
  `;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}
