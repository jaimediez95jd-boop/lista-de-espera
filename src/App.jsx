import { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy } from "firebase/firestore";

const CIRUGIAS_GRUPOS = {
  "Hallux": [
    "Hallux valgus (osteotomía chevron)",
    "Hallux valgus (osteotomía Scarf)",
    "Hallux valgus (osteotomía Lapidus)",
    "Hallux rigidus (queilectomía)",
    "Hallux rigidus (artrodesis 1ª MTF)",
    "Sesamoidectomía",
  ],
  "Dedos menores": [
    "Dedo en martillo (proximal)",
    "Dedo en garra",
    "Dedo en maza",
    "Metatarsalgia (osteotomía Weil)",
    "Neuroma de Morton",
    "Sinovitis 2ª MTF",
    "Amputación dedo",
  ],
  "Tendones": [
    "Reparación tendón Aquiles (aguda)",
    "Reparación tendón Aquiles (crónica)",
    "Tenotomía / alargamiento Aquiles",
    "Reparación tendón tibial posterior",
    "Reparación tendón peroneo",
    "Tenolisis",
    "Transferencia tendinosa",
  ],
  "Pie": [
    "Fasciotomía plantar (endoscópica)",
    "Fasciotomía plantar (abierta)",
    "Osteotomía calcáneo (Dwyer)",
    "Osteotomía calcáneo (Evans)",
    "Osteotomía calcáneo (medializante)",
    "Artrodesis mediopié",
    "Artrodesis de Lisfranc",
    "Corrección pie plano adulto",
    "Corrección pie cavo",
    "Resección espolón calcáneo",
    "Resección exostosis dorsal",
    "Bursectomía retrocalcánea",
  ],
  "Tobillo": [
    "Artrodesis tobillo",
    "Artroscopia tobillo (diagnóstica)",
    "Artroscopia tobillo (terapéutica)",
    "Ligamentoplastia tobillo (Broström)",
    "Ligamentoplastia tobillo (Broström-Gould)",
    "Reparación sindesmosis",
    "Osteocondral tobillo (mosaicoplastia)",
    "Osteocondral tobillo (microfracturas)",
    "Prótesis total de tobillo",
    "Revisión prótesis tobillo",
  ],
  "Fracturas": [
    "Fractura maleolo lateral",
    "Fractura maleolo medial",
    "Fractura bimaleolar",
    "Fractura trimaleolar",
    "Fractura calcáneo (RAFI)",
    "Fractura astrágalo",
    "Fractura 5º metatarsiano",
    "Fractura otros metatarsianos",
    "Fractura falange",
    "Retirada material osteosíntesis",
  ],
  "Otras": [
    "Ganglio / quiste sinovial",
    "Tumor partes blandas",
    "Desbridamiento infección",
    "Artrodesis subtalar",
    "Artrorisis subtalar",
    "Otra intervención",
  ],
};

const ESTADOS = ["Lista de espera", "Programado", "Operado", "Alta", "Baja / Cancelado"];

const initialForm = {
  nombre: "", apellidos: "", nhc: "", edad: "",
  cirugia: "", fechaSolicitud: "", fechaCirugia: "",
  estado: "Lista de espera", observaciones: "",
  fechaCreacion: new Date().toISOString(),
};

const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

const formatDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
};

const diasEspera = (fechaSolicitud) => {
  if (!fechaSolicitud) return null;
  const diff = Math.floor((new Date() - new Date(fechaSolicitud)) / (1000 * 60 * 60 * 24));
  return diff;
};

async function extractFromImage(base64Data, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          {
            type: "text",
            text: `Analiza esta imagen de una pantalla de ordenador de un sistema hospitalario español (HIS/HCIS). Extrae estos datos del paciente si los ves claramente:
- nombre: solo nombre de pila
- apellidos: uno o dos apellidos
- nhc: número de historia clínica / NHC (solo dígitos)
- edad: edad en años (solo número)

Devuelve SOLO un JSON válido sin explicaciones ni markdown. Campos no encontrados deja como "".
Formato exacto: {"nombre":"","apellidos":"","nhc":"","edad":""}`
          }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || "").join("").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(raw);
}

function exportCSV(pacientes) {
  const headers = ["Nombre", "Apellidos", "NHC", "Edad", "Cirugía", "F. Solicitud", "F. Cirugía", "Estado", "Días espera", "Observaciones"];
  const rows = pacientes.map(p => [
    p.nombre, p.apellidos, p.nhc, p.edad, p.cirugia,
    p.fechaSolicitud ? formatDate(p.fechaSolicitud) : "",
    p.fechaCirugia ? formatDate(p.fechaCirugia) : "",
    p.estado,
    p.fechaSolicitud ? diasEspera(p.fechaSolicitud) : "",
    (p.observaciones || "").replace(/\n/g, " ")
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `lista-espera-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

export default function App() {
  const [pacientes, setPacientes] = useState([]);
  const [vista, setVista] = useState("lista");
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(initialForm);
  const [filtro, setFiltro] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [scanState, setScanState] = useState("idle");
  const [scanPreview, setScanPreview] = useState(null);
  const [scanError, setScanError] = useState("");
  const scanRef = useRef();

  useEffect(() => {
    const q = query(collection(db, "publica-diez-saralegui"), orderBy("fechaCreacion", "desc"));
    const unsub = onSnapshot(q, snap => {
      setPacientes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, []);

  function showToast(msg, type = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function handleNuevo() {
    setForm({ ...initialForm, fechaSolicitud: new Date().toISOString().slice(0, 10), fechaCreacion: new Date().toISOString() });
    setScanPreview(null); setScanState("idle"); setScanError("");
    setVista("nuevo");
  }

  function handleEditar(p) {
    setForm({ ...p });
    setSelected(p);
    setScanPreview(null); setScanState("idle"); setScanError("");
    setVista("editar");
  }

  function handleVer(p) { setSelected(p); setVista("detalle"); }

  async function handleGuardar() {
    if (!form.nombre?.trim() || !form.apellidos?.trim()) { showToast("Nombre y apellidos son obligatorios", "error"); return; }
    if (!form.cirugia) { showToast("Selecciona el tipo de cirugía", "error"); return; }
    setSaving(true);
    try {
      const { id, ...datos } = form;
      const payload = { ...datos, updatedAt: new Date().toISOString() };
      if (vista === "nuevo") {
        await addDoc(collection(db, "publica-diez-saralegui"), payload);
        showToast("Paciente añadido a lista de espera ✓");
      } else {
        await updateDoc(doc(db, "publica-diez-saralegui", form.id), payload);
        showToast("Paciente actualizado ✓");
      }
      setVista("lista");
    } catch (e) { showToast("Error al guardar: " + e.message, "error"); }
    setSaving(false);
  }

  async function handleDelete(id) {
    try { await deleteDoc(doc(db, "publica-diez-saralegui", id)); showToast("Paciente eliminado"); }
    catch { showToast("Error al eliminar", "error"); }
    setConfirmDelete(null); setVista("lista");
  }

  async function cambiarEstado(p, estado) {
    try {
      await updateDoc(doc(db, "publica-diez-saralegui", p.id), { estado, updatedAt: new Date().toISOString() });
      showToast(`Estado → ${estado} ✓`);
    } catch { showToast("Error al actualizar", "error"); }
  }

  function handleScanClick() { scanRef.current?.click(); }

  async function handleScanFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { showToast("Usa JPG, PNG o WEBP", "error"); return; }
    if (file.size > 8 * 1024 * 1024) { showToast("Imagen demasiado grande (máx. 8 MB)", "error"); return; }
    setScanState("loading"); setScanError(""); setScanPreview(null);
    try {
      const dataUrl = await readFile(file);
      setScanPreview(dataUrl);
      const extracted = await extractFromImage(dataUrl.split(",")[1], file.type);
      let filled = 0;
      setForm(prev => {
        const u = { ...prev };
        ["nombre", "apellidos", "nhc", "edad"].forEach(k => { if (extracted[k] && !prev[k]) { u[k] = extracted[k]; filled++; } });
        return u;
      });
      if (filled === 0) { setScanState("error"); setScanError("No se detectaron datos. Rellena manualmente."); }
      else { setScanState("done"); showToast(`${filled} campos extraídos ✓`); }
    } catch { setScanState("error"); setScanError("Error al analizar. Rellena manualmente."); }
  }

  function readFile(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => rej(new Error("Error leyendo archivo"));
      r.readAsDataURL(file);
    });
  }

  const filtrados = pacientes.filter(p => {
    const txt = `${p.nombre} ${p.apellidos} ${p.nhc} ${p.cirugia}`.toLowerCase();
    return txt.includes(filtro.toLowerCase()) && (filtroEstado === "todos" || p.estado === filtroEstado);
  });

  const stats = {
    total: pacientes.length,
    espera: pacientes.filter(p => p.estado === "Lista de espera").length,
    programados: pacientes.filter(p => p.estado === "Programado").length,
    operados: pacientes.filter(p => p.estado === "Operado" || p.estado === "Alta").length,
  };

  if (loading) return (
    <div style={S.loadingWrap}>
      <div style={S.spinner} />
      <p style={{ color: "#64748b", marginTop: 16 }}>Cargando lista de espera...</p>
    </div>
  );

  const isForm = vista === "nuevo" || vista === "editar";

  return (
    <div style={S.app}>
      {toast && <div style={{ ...S.toast, background: toast.type === "error" ? "#ef4444" : "#10b981" }}>{toast.msg}</div>}

      {confirmDelete && (
        <div style={S.overlay}>
          <div style={S.confirmCard}>
            <p style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>¿Eliminar este paciente?</p>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 22 }}>Esta acción no se puede deshacer.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={S.btnDanger} onClick={() => handleDelete(confirmDelete)}>Eliminar</button>
              <button style={S.btnSecondary} onClick={() => setConfirmDelete(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={{ fontSize: 20 }}>🏥</span>
          <div>
            <div style={S.brandH}>Lista de Espera · Pública</div>
            <div style={S.brandSub}>Dr. Díez Saralegui · Pie y Tobillo</div>
          </div>
        </div>
        <div style={S.headerRight}>
          {saving && <span style={S.savingBadge}>Guardando...</span>}
        </div>
      </header>

      <main style={S.main}>

        {vista === "lista" && (<>
          <div style={S.statsRow}>
            {[
              { label: "Total", value: stats.total, color: "#6366f1" },
              { label: "En espera", value: stats.espera, color: "#f59e0b" },
              { label: "Programados", value: stats.programados, color: "#3b82f6" },
              { label: "Operados / Alta", value: stats.operados, color: "#10b981" },
            ].map(s => (
              <div key={s.label} style={{ ...S.statCard, borderTop: `3px solid ${s.color}` }}>
                <div style={{ ...S.statNum, color: s.color }}>{s.value}</div>
                <div style={S.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>

          <div style={S.toolbar}>
            <input style={S.search} placeholder="Buscar por nombre, NHC, cirugía..." value={filtro} onChange={e => setFiltro(e.target.value)} />
            <select style={S.select} value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
              <option value="todos">Todos los estados</option>
              {ESTADOS.map(e => <option key={e}>{e}</option>)}
            </select>
            <button style={S.btnExport} onClick={() => exportCSV(filtrados)}>⬇ Exportar</button>
            <button style={S.btnPrimary} onClick={handleNuevo}>+ Añadir paciente</button>
          </div>

          {filtrados.length === 0 ? (
            <div style={S.empty}>
              <div style={{ fontSize: 48 }}>🏥</div>
              <p style={{ color: "#94a3b8", marginTop: 8 }}>No hay pacientes con estos filtros.</p>
            </div>
          ) : (
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>{["Paciente", "NHC", "Edad", "Cirugía", "F. Solicitud", "Días espera", "Estado", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {filtrados.map(p => {
                    const dias = diasEspera(p.fechaSolicitud);
                    const diasColor = dias > 365 ? "#ef4444" : dias > 180 ? "#f59e0b" : "#10b981";
                    return (
                      <tr key={p.id} style={S.tr}>
                        <td style={S.td}><div style={{ fontWeight: 700, color: "#1e293b" }}>{p.nombre} {p.apellidos}</div></td>
                        <td style={S.td}><span style={S.mono}>{p.nhc || "—"}</span></td>
                        <td style={S.td}>{p.edad ? `${p.edad}a` : "—"}</td>
                        <td style={S.td}><span style={S.cirugiaBadge}>{p.cirugia}</span></td>
                        <td style={S.td}>{formatDate(p.fechaSolicitud)}</td>
                        <td style={S.td}>{dias !== null ? <span style={{ fontWeight: 700, color: diasColor }}>{dias}d</span> : "—"}</td>
                        <td style={S.td}>
                          <select style={{ ...S.estadoSelect, ...estadoColor(p.estado) }} value={p.estado} onChange={e => cambiarEstado(p, e.target.value)}>
                            {ESTADOS.map(e => <option key={e}>{e}</option>)}
                          </select>
                        </td>
                        <td style={S.td}>
                          <div style={{ display: "flex", gap: 5 }}>
                            <button style={S.btnIcon} onClick={() => handleVer(p)}>👁</button>
                            <button style={S.btnIcon} onClick={() => handleEditar(p)}>✏️</button>
                            <button style={S.btnIcon} onClick={() => setConfirmDelete(p.id)}>🗑</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={S.tableFooter}>{filtrados.length} paciente{filtrados.length !== 1 ? "s" : ""}</div>
            </div>
          )}
        </>)}

        {vista === "detalle" && selected && (
          <div style={S.formCard}>
            <div style={S.formHeader}>
              <button style={S.backBtn} onClick={() => setVista("lista")}>← Volver</button>
              <h2 style={S.formTitle}>{selected.nombre} {selected.apellidos}</h2>
              <button style={S.btnPrimary} onClick={() => handleEditar(selected)}>Editar</button>
            </div>
            <div style={S.detalleGrid}>
              <DetalleItem label="NHC" value={selected.nhc} accent />
              <DetalleItem label="Edad" value={selected.edad ? `${selected.edad} años` : null} />
              <DetalleItem label="Cirugía" value={selected.cirugia} accent />
              <DetalleItem label="Estado" value={selected.estado} />
              <DetalleItem label="F. Solicitud" value={formatDate(selected.fechaSolicitud)} />
              <DetalleItem label="F. Cirugía" value={formatDate(selected.fechaCirugia)} />
              <DetalleItem label="Días en espera" value={diasEspera(selected.fechaSolicitud) !== null ? `${diasEspera(selected.fechaSolicitud)} días` : null} />
            </div>
            {selected.observaciones && (
              <div style={S.notasBox}>
                <div style={S.notasLabel}>Observaciones</div>
                <div style={S.notasText}>{selected.observaciones}</div>
              </div>
            )}
          </div>
        )}

        {isForm && (
          <div style={S.formCard}>
            <div style={S.formHeader}>
              <button style={S.backBtn} onClick={() => setVista("lista")}>← Volver</button>
              <h2 style={S.formTitle}>{vista === "nuevo" ? "Añadir a lista de espera" : "Editar paciente"}</h2>
            </div>

            <div style={S.scanSection}>
              <div style={{ flex: 1 }}>
                <div style={S.scanTitle}>📸 Escanear pantalla del ordenador</div>
                <div style={S.scanDesc}>Haz una captura de pantalla del HIS o sube una foto y la IA extraerá los datos del paciente automáticamente.</div>
                <input ref={scanRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} onChange={handleScanFile} />
                <button style={{ ...S.btnScan, opacity: scanState === "loading" ? 0.65 : 1, cursor: scanState === "loading" ? "wait" : "pointer" }} onClick={handleScanClick} disabled={scanState === "loading"}>
                  {scanState === "loading" ? "⏳ Analizando..." : scanState === "done" ? "✓ Extraído — subir otra" : "📸 Subir captura de pantalla"}
                </button>
                {scanState === "error" && <div style={S.scanMsg}>{scanError}</div>}
                {scanState === "done" && <div style={{ ...S.scanMsg, color: "#16a34a" }}>✓ Revisa y completa lo que falte.</div>}
              </div>
              {scanPreview && <img src={scanPreview} alt="" style={S.scanPreview} />}
            </div>

            <SectionTitle>Datos del paciente</SectionTitle>
            <div style={S.formGrid}>
              <FormField label="Nombre *" value={form.nombre} onChange={v => setForm({ ...form, nombre: v })} />
              <FormField label="Apellidos *" value={form.apellidos} onChange={v => setForm({ ...form, apellidos: v })} />
              <FormField label="NHC" value={form.nhc} onChange={v => setForm({ ...form, nhc: v })} placeholder="123456" />
              <FormField label="Edad (años)" value={form.edad} onChange={v => setForm({ ...form, edad: v })} type="number" placeholder="58" />
            </div>

            <SectionTitle>Cirugía</SectionTitle>
            <div style={S.formGrid}>
              <div style={S.fieldWrap}>
                <label style={S.label}>Tipo de cirugía *</label>
                <select style={S.input} value={form.cirugia} onChange={e => setForm({ ...form, cirugia: e.target.value })}>
                  <option value="">Seleccionar...</option>
                  {Object.entries(CIRUGIAS_GRUPOS).map(([grupo, items]) => (
                    <optgroup key={grupo} label={`── ${grupo}`}>
                      {items.map(c => <option key={c}>{c}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <FormField label="Fecha solicitud / entrada en lista" value={form.fechaSolicitud} onChange={v => setForm({ ...form, fechaSolicitud: v })} type="date" />
              <FormField label="Fecha cirugía (si está programada)" value={form.fechaCirugia} onChange={v => setForm({ ...form, fechaCirugia: v })} type="date" />
              <div style={S.fieldWrap}>
                <label style={S.label}>Estado</label>
                <select style={S.input} value={form.estado} onChange={e => setForm({ ...form, estado: e.target.value })}>
                  {ESTADOS.map(e => <option key={e}>{e}</option>)}
                </select>
              </div>
            </div>

            <SectionTitle>Observaciones</SectionTitle>
            <textarea style={{ ...S.input, minHeight: 100, resize: "vertical" }} value={form.observaciones} onChange={e => setForm({ ...form, observaciones: e.target.value })} placeholder="Diagnóstico, indicación quirúrgica, alergias, comorbilidades, preferencias del paciente..." />

            <div style={S.formActions}>
              <button style={S.btnPrimary} onClick={handleGuardar}>{saving ? "Guardando..." : vista === "nuevo" ? "Añadir a lista" : "Actualizar"}</button>
              <button style={S.btnSecondary} onClick={() => setVista("lista")}>Cancelar</button>
              {vista === "editar" && <button style={S.btnDanger} onClick={() => setConfirmDelete(form.id)}>Eliminar</button>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ children }) { return <div style={S.sectionTitle}>{children}</div>; }
function DetalleItem({ label, value, accent }) {
  return (
    <div style={S.detalleItem}>
      <div style={S.detalleLabel}>{label}</div>
      <div style={{ ...S.detalleValue, color: accent ? "#6366f1" : "#1e293b", fontWeight: accent ? 700 : 500 }}>{value || "—"}</div>
    </div>
  );
}
function FormField({ label, value, onChange, type = "text", placeholder }) {
  return (
    <div style={S.fieldWrap}>
      <label style={S.label}>{label}</label>
      <input style={S.input} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || ""} />
    </div>
  );
}
function estadoColor(e) {
  return ({
    "Lista de espera": { background: "#fef3c7", color: "#92400e" },
    "Programado": { background: "#dbeafe", color: "#1e40af" },
    "Operado": { background: "#dcfce7", color: "#166534" },
    "Alta": { background: "#f0fdf4", color: "#15803d" },
    "Baja / Cancelado": { background: "#f1f5f9", color: "#64748b" },
  })[e] || {};
}

const S = {
  app: { minHeight: "100vh", background: "#f8fafc", fontFamily: "'Segoe UI',sans-serif" },
  loadingWrap: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  spinner: { width: 36, height: 36, border: "3px solid #e2e8f0", borderTop: "3px solid #6366f1", borderRadius: "50%", animation: "spin .8s linear infinite" },
  header: { background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "0 24px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10 },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  brandH: { fontWeight: 900, fontSize: 16, color: "#1e293b", letterSpacing: "-0.3px" },
  brandSub: { fontSize: 11, color: "#6366f1", fontWeight: 600 },
  savingBadge: { fontSize: 12, color: "#6366f1", background: "#eef2ff", padding: "2px 8px", borderRadius: 20 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  main: { maxWidth: 1200, margin: "0 auto", padding: "24px 16px" },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 22 },
  statCard: { background: "#fff", borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 4px rgba(0,0,0,.06)" },
  statNum: { fontSize: 30, fontWeight: 800, lineHeight: 1 },
  statLabel: { fontSize: 12, color: "#64748b", marginTop: 4 },
  toolbar: { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  search: { flex: 1, minWidth: 180, padding: "8px 13px", border: "1.5px solid #e2e8f0", borderRadius: 9, fontSize: 14, outline: "none", background: "#fff" },
  select: { padding: "8px 12px", border: "1.5px solid #e2e8f0", borderRadius: 9, fontSize: 13, background: "#fff", cursor: "pointer" },
  btnPrimary: { padding: "8px 18px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnSecondary: { padding: "8px 18px", background: "#f1f5f9", color: "#475569", border: "none", borderRadius: 9, fontWeight: 600, fontSize: 13, cursor: "pointer" },
  btnDanger: { padding: "8px 18px", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 9, fontWeight: 600, fontSize: 13, cursor: "pointer" },
  btnExport: { padding: "8px 16px", background: "#f0fdf4", color: "#15803d", border: "1.5px solid #bbf7d0", borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnIcon: { padding: "5px 9px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 7, cursor: "pointer", fontSize: 13 },
  tableWrap: { background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,.06)", overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "11px 14px", textAlign: "left", fontWeight: 700, color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tr: { borderBottom: "1px solid #f8fafc" },
  td: { padding: "11px 14px", verticalAlign: "middle" },
  mono: { fontFamily: "monospace", fontSize: 12, color: "#475569" },
  cirugiaBadge: { fontSize: 11, background: "#eef2ff", color: "#4338ca", padding: "2px 7px", borderRadius: 20, fontWeight: 600 },
  estadoSelect: { fontSize: 11, padding: "3px 8px", borderRadius: 20, fontWeight: 700, border: "none", cursor: "pointer" },
  tableFooter: { padding: "10px 16px", fontSize: 12, color: "#94a3b8", borderTop: "1px solid #f1f5f9" },
  empty: { textAlign: "center", padding: "70px 20px", background: "#fff", borderRadius: 12 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  confirmCard: { background: "#fff", borderRadius: 16, padding: "30px 26px", maxWidth: 340, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.2)" },
  toast: { position: "fixed", bottom: 22, right: 22, color: "#fff", padding: "11px 18px", borderRadius: 11, fontWeight: 600, zIndex: 200, boxShadow: "0 4px 20px rgba(0,0,0,.15)", fontSize: 13 },
  formCard: { background: "#fff", borderRadius: 14, padding: "26px", boxShadow: "0 1px 4px rgba(0,0,0,.06)", maxWidth: 860, margin: "0 auto" },
  formHeader: { display: "flex", alignItems: "center", gap: 14, marginBottom: 22 },
  formTitle: { fontSize: 20, fontWeight: 800, color: "#1e293b", flex: 1, margin: 0 },
  backBtn: { background: "none", border: "none", color: "#6366f1", fontWeight: 700, cursor: "pointer", fontSize: 14, padding: 0 },
  scanSection: { background: "linear-gradient(135deg,#eef2ff,#f0f9ff)", border: "1.5px dashed #a5b4fc", borderRadius: 13, padding: "18px 20px", marginBottom: 22, display: "flex", alignItems: "center", gap: 18 },
  scanTitle: { fontWeight: 700, color: "#4338ca", fontSize: 14, marginBottom: 3 },
  scanDesc: { fontSize: 12, color: "#64748b", marginBottom: 10 },
  btnScan: { padding: "8px 16px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12 },
  scanMsg: { fontSize: 12, color: "#dc2626", marginTop: 7 },
  scanPreview: { width: 100, height: 70, objectFit: "cover", borderRadius: 9, border: "2px solid #a5b4fc", flexShrink: 0 },
  sectionTitle: { fontWeight: 700, color: "#6366f1", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12, marginTop: 22, paddingBottom: 5, borderBottom: "1px solid #eef2ff" },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: "12px 18px" },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".04em" },
  input: { padding: "8px 11px", border: "1.5px solid #e2e8f0", borderRadius: 8, fontSize: 13, outline: "none", background: "#fafafa", width: "100%", boxSizing: "border-box" },
  formActions: { display: "flex", gap: 10, marginTop: 28, flexWrap: "wrap" },
  detalleGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 12, marginBottom: 18 },
  detalleItem: { padding: "11px 13px", background: "#f8fafc", borderRadius: 9 },
  detalleLabel: { fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 3 },
  detalleValue: { fontSize: 14, color: "#1e293b" },
  notasBox: { background: "#fef9c3", border: "1px solid #fde68a", borderRadius: 9, padding: "12px 14px", marginTop: 6 },
  notasLabel: { fontWeight: 700, color: "#92400e", fontSize: 11, marginBottom: 5 },
  notasText: { color: "#451a03", fontSize: 13, lineHeight: 1.6 },
};
