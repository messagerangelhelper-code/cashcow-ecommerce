// CashCow eCommerce control dashboard: orders from the Ecwid store, matched by ZIP code to the
// nearest supplier warehouse and local logistics hub, grouped into delivery routes.
(function () {
  const API = "https://cashcow-reviews-api.onrender.com";
  const sb = window.supabase.createClient("https://wbugdujmydwmzemccbiy.supabase.co", "sb_publishable_4RYit1aVs5Egh3gJsx2bJA_m6Kje0ES");
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    AWAITING_PROCESSING: "New", PROCESSING: "Processing", SHIPPED: "Shipped", OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered", READY_FOR_PICKUP: "Ready for pickup", WILL_NOT_DELIVER: "Won't deliver", RETURNED: "Returned",
  };
  let session = null;
  let warehouses = [];
  let rules = [];
  const loaded = {};

  // Small element builder: h("div", {class: "x"}, "text", child...)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const money = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (s) => { const d = new Date(String(s || "").replace(" +0000", "Z").replace(" ", "T")); return isNaN(d) ? (s || "") : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  let flashTimer;
  function flash(msg, bad) {
    const f = $("flash"); f.textContent = msg; f.hidden = false; f.className = bad ? "flash bad" : "flash";
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { f.hidden = true; }, 5000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).catch(() => { throw new Error("Couldn't reach the CashCow server. It may be waking up; try again in a minute."); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Something went wrong (${res.status}).`);
    return data;
  }
  function loading(box) { box.replaceChildren(h("p", { class: "empty" }, "Loading...")); }
  function failed(box, err, retry) {
    box.replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, err.message), h("button", { class: "ghost", onclick: retry }, "Try again")));
  }

  // ---------- Sign in ----------
  function showSignedIn() {
    const signed = !!session;
    $("signin").hidden = signed;
    $("dash").hidden = !signed;
    $("who").hidden = !signed;
    if (signed) {
      $("who").replaceChildren(session.user.email, " · ", h("a", { href: "#", onclick: async (e) => { e.preventDefault(); await sb.auth.signOut(); } }, "Sign out"));
      openTab(location.hash.slice(1) || "overview");
    }
  }
  $("signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("signinError"); err.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    if (error) { err.textContent = error.message; err.hidden = false; }
  });
  sb.auth.onAuthStateChange((_e, s) => {
    const was = !!session; session = s;
    if (was !== !!s) { Object.keys(loaded).forEach((k) => delete loaded[k]); showSignedIn(); }
  });
  sb.auth.getSession().then(({ data }) => { session = data.session; showSignedIn(); });

  // ---------- Tabs ----------
  const TABS = { overview: loadOverview, orders: loadOrders, routes: loadRoutes, warehouses: loadWarehouses, products: loadProducts, zip: loadZip, ask: loadAsk };
  function openTab(name, force) {
    if (!TABS[name]) name = "overview";
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
    if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    if (!loaded[name] || force) { loaded[name] = true; TABS[name]($(`tab-${name}`)); }
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));

  async function ensureWarehouses() {
    const d = await api("/api/ecom/warehouses");
    warehouses = d.warehouses || []; rules = d.rules || [];
  }
  const hubs = () => warehouses.filter((w) => w.kind === "logistics" && w.active);

  // ---------- Overview ----------
  async function loadOverview(box) {
    loading(box);
    try {
      const d = await api("/api/ecom/overview");
      if (!d.ecwid) {
        box.replaceChildren(h("div", { class: "card setup" }, h("h2", {}, "Connect your Ecwid store"),
          h("ol", {}, h("li", {}, "Render → cashcow-reviews-api → Environment."),
            h("li", {}, "Add ECWID_STORE_ID (your store number) and ECWID_SECRET_TOKEN (starts with secret_)."),
            h("li", {}, "Wait for the server to restart, then reload this page."))));
        return;
      }
      const stat = (n, label, alert) => h("div", { class: alert && n ? "stat alert" : "stat" }, h("b", {}, n), h("span", {}, label));
      const max = Math.max(1, ...d.open_by_state.map((s) => s[1]));
      box.replaceChildren(
        h("p", { class: "muted small" }, "Store: ", d.store || "connected"),
        h("div", { class: "stats" },
          stat(money(d.sales30), "Paid sales, last 30 days"), stat(d.orders30, "Paid orders, last 30 days"),
          stat(d.open, "Open orders"), stat(d.to_process, "New, not started", true),
          stat(d.by_hand, "Need ordering by hand", true), stat(d.no_hub, "No local hub yet", true),
          stat(d.bad_zip, "ZIP code not found", true), stat(`${d.hubs} / ${d.supplier_warehouses}`, "Local hubs / supplier warehouses")),
        h("div", { class: "card" }, h("h3", {}, "Open orders by state"),
          d.open_by_state.length ? h("div", { class: "bars" }, d.open_by_state.map(([st, n]) =>
            h("div", { class: "bar" }, h("span", {}, st), h("i", { style: `width:${Math.round((n / max) * 100)}%` }), h("em", {}, n))))
            : h("p", { class: "muted" }, "No open orders right now.")),
        (!d.hubs || !d.supplier_warehouses) ? h("div", { class: "card setup" }, h("h3", {}, "Finish setting up routing"),
          h("ol", {}, !d.supplier_warehouses && h("li", {}, "Add the supplier warehouses your products ship from (Warehouses tab)."),
            !d.hubs && h("li", {}, "Add your local logistics hubs, the warehouses that handle delivery in each area."),
            h("li", {}, "Add SKU rules so each product knows its supplier (Warehouses tab, bottom)."))) : null,
        h("button", { class: "ghost", onclick: () => openTab("overview", true) }, "Refresh"));
    } catch (err) { failed(box, err, () => openTab("overview", true)); }
  }

  // ---------- Orders ----------
  let orderView = "open";
  let orderSearch = "";
  async function loadOrders(box) {
    loading(box);
    try {
      const [d] = await Promise.all([api(`/api/ecom/orders?view=${orderView}`), ensureWarehouses()]);
      const search = h("input", { type: "search", placeholder: "Search name, ZIP, order # or product", value: orderSearch,
        "aria-label": "Search orders", oninput: (e) => { orderSearch = e.target.value; draw(); } });
      const view = h("select", { "aria-label": "Which orders", onchange: (e) => { orderView = e.target.value; openTab("orders", true); } },
        h("option", { value: "open", selected: orderView === "open" }, "Open orders"),
        h("option", { value: "all", selected: orderView === "all" }, "All, last 90 days"));
      const list = h("div", { class: "list" });
      function draw() {
        const q = orderSearch.trim().toLowerCase();
        const rows = d.orders.filter((o) => !q || [o.customer, o.zip, o.number, o.address, ...o.items.map((i) => `${i.name} ${i.sku}`)].join(" ").toLowerCase().includes(q));
        list.replaceChildren(...(rows.length ? rows.map(orderCard) : [h("p", { class: "empty" }, "No orders here.")]));
      }
      box.replaceChildren(h("div", { class: "toolbar" }, search, view, h("button", { class: "ghost", onclick: () => openTab("orders", true) }, "Refresh")), list);
      draw();
    } catch (err) { failed(box, err, () => openTab("orders", true)); }
  }

  function orderCard(o) {
    const status = h("select", { "aria-label": `Status for order ${o.number}` },
      Object.entries(STATUS).map(([v, l]) => h("option", { value: v, selected: v === o.status }, l)));
    const tracking = h("input", { value: o.tracking, placeholder: "Tracking number", "aria-label": `Tracking for order ${o.number}` });
    const hub = h("select", { "aria-label": `Local hub for order ${o.number}` },
      h("option", { value: "" }, "Nearest hub (automatic)"),
      hubs().map((w) => h("option", { value: w.id, selected: o.hub_manual && o.hub && o.hub.id === w.id }, `${w.name} (${w.city}, ${w.state})`)));
    const notes = h("input", { value: o.notes, placeholder: "Notes for this order", "aria-label": `Notes for order ${o.number}` });
    const save = h("button", {
      onclick: async () => {
        save.disabled = true;
        try {
          await api(`/api/ecom/orders/${encodeURIComponent(o.id)}`, { body: {
            status: status.value !== o.status ? status.value : "", tracking: tracking.value !== o.tracking ? tracking.value : null,
            hub_id: hub.value, notes: notes.value } });
          flash(`Order ${o.number} saved.`);
          delete loaded.overview; delete loaded.routes;
          openTab("orders", true);
        } catch (err) { flash(err.message, true); save.disabled = false; }
      },
    }, "Save");
    const paid = o.payment === "PAID";
    return h("article", { class: "card" },
      h("div", { class: "order-head" },
        h("h3", {}, `#${o.number} · ${o.customer || "No name"}`),
        h("span", {}, h("span", { class: paid ? "pill good" : "pill gold" }, paid ? "Paid" : (o.payment || "Unpaid").replace(/_/g, " ").toLowerCase()), " ",
          h("span", { class: "pill" }, STATUS[o.status] || o.status))),
      h("p", { class: "muted small" }, when(o.created), " · ", money(o.total), o.phone ? ` · ${o.phone}` : ""),
      h("p", { class: "small" }, o.address || "No shipping address",
        !o.zip_found ? h("span", { class: "pill bad" }, " ZIP not found") : null),
      h("p", { class: "small" }, "🚚 Local hub: ", o.hub ? h("strong", {}, `${o.hub.name}`, o.hub.miles != null ? ` · ${o.hub.miles} mi` : "") : h("span", { class: "pill gold" }, "none yet")),
      h("ul", { class: "items" }, o.items.map((i) => h("li", {},
        h("strong", {}, `${i.quantity} × ${i.name}`), i.sku ? ` (${i.sku})` : "", h("br"),
        i.by_hand ? [h("span", { class: "pill gold" }, `Order by hand from ${i.supplier}`), " "] : null,
        i.ships_from ? `Ships from ${i.ships_from.name}, ${i.ships_from.city} ${i.ships_from.state} · ${i.ships_from.miles} mi · ${i.ships_from.days}`
          : !i.by_hand ? h("span", { class: "muted" }, "No supplier warehouse matched") : null))),
      h("div", { class: "row" }, status, tracking),
      h("div", { class: "row" }, hub, notes, save));
  }

  // ---------- Routes ----------
  async function loadRoutes(box) {
    loading(box);
    try {
      const d = await api("/api/ecom/routes");
      const cards = d.routes.map((r) => h("article", { class: "card" },
        h("div", { class: "order-head" }, h("h3", {}, `🏭 ${r.hub.name}`), h("span", { class: "pill" }, `${r.stops.length} stop${r.stops.length === 1 ? "" : "s"}`)),
        h("p", { class: "muted small" }, `${r.hub.city}, ${r.hub.state} ${r.hub.zip}`, r.stops.length ? ` · about ${r.miles} miles` : ""),
        r.stops.length ? h("ol", { class: "stops" }, r.stops.map((s) => h("li", {},
          h("strong", {}, `#${s.number} ${s.customer}`), ` · ${s.address}`, h("br"),
          h("span", { class: "muted small" }, s.items.map((i) => `${i.quantity}× ${i.name}`).join(", "), " · ", STATUS[s.status] || s.status))))
          : h("p", { class: "muted" }, "No open orders for this hub."),
        r.links.length ? h("div", { class: "links" }, r.links.map((l, i) => h("a", { href: l, target: "_blank", rel: "noopener" }, r.links.length > 1 ? `Open route in Maps (part ${i + 1})` : "Open route in Maps"))) : null));
      box.replaceChildren(
        h("div", { class: "toolbar" }, h("p", { class: "muted small", style: "margin:0;flex:1" }, "Open orders grouped by the local hub nearest each customer, in driving order."),
          h("button", { class: "ghost", onclick: () => openTab("routes", true) }, "Refresh")),
        d.unrouted.length ? h("div", { class: "card" }, h("h3", {}, `⚠️ ${d.unrouted.length} order${d.unrouted.length === 1 ? "" : "s"} without a hub`),
          h("p", { class: "muted small" }, "Add a logistics hub near these customers, or check the ZIP code."),
          h("ul", { class: "items" }, d.unrouted.map((o) => h("li", {}, `#${o.number} ${o.customer} · ${o.address || o.zip || "no address"}`)))) : null,
        ...(cards.length ? cards : [h("div", { class: "card empty" }, "No logistics hubs yet. Add one in the Warehouses tab.")]));
    } catch (err) { failed(box, err, () => openTab("routes", true)); }
  }

  // ---------- Warehouses and SKU rules ----------
  async function loadWarehouses(box) {
    loading(box);
    try {
      await ensureWarehouses();
      const form = warehouseForm(null);
      const list = h("div", { class: "grid2" }, warehouses.length ? warehouses.map((w) => h("article", { class: "card" },
        h("div", { class: "order-head" }, h("h3", {}, w.name),
          h("span", { class: w.kind === "logistics" ? "pill" : "pill gold" }, w.kind === "logistics" ? "Local hub" : `Supplier${w.supplier ? ": " + w.supplier : ""}`)),
        h("p", { class: "small" }, `${w.address ? w.address + ", " : ""}${w.city}, ${w.state} ${w.zip}`, !w.active ? h("span", { class: "pill bad" }, " Off") : null),
        w.categories ? h("p", { class: "muted small" }, w.categories) : null,
        w.phone ? h("p", { class: "small" }, h("a", { href: `tel:${w.phone.replace(/[^\d+]/g, "")}` }, w.phone)) : null,
        h("div", { class: "links" },
          h("button", { class: "ghost", onclick: () => { box.prepend(warehouseForm(w)); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Edit"),
          h("button", { class: "danger", onclick: async () => {
            if (!confirm(`Delete ${w.name}?`)) return;
            try { await api(`/api/ecom/warehouses/${w.id}/delete`, { method: "POST" }); flash("Warehouse deleted."); refreshAfterSetup(); }
            catch (err) { flash(err.message, true); }
          } }, "Delete")))) : [h("p", { class: "empty" }, "No warehouses yet.")]);

      const ruleMatch = h("input", { placeholder: "SKU starts with, e.g. CJ-", "aria-label": "SKU starts with" });
      const ruleSup = h("input", { placeholder: "Supplier, e.g. CJ", "aria-label": "Supplier name" });
      const rulesCard = h("div", { class: "card" }, h("h3", {}, "SKU rules: which supplier sells each product"),
        h("p", { class: "muted small" }, "Products whose SKU starts with these letters come from that supplier. Orders then ship from that supplier's nearest warehouse. A supplier with no warehouse listed (like CROV) is flagged \"order by hand\"."),
        h("ul", { class: "items" }, rules.length ? rules.map((r) => h("li", {}, h("strong", {}, r.match), ` → ${r.supplier} `,
          h("button", { class: "danger", style: "min-height:30px;padding:4px 10px", onclick: async () => {
            try { await api(`/api/ecom/rules/${r.id}/delete`, { method: "POST" }); flash("Rule removed."); refreshAfterSetup(); } catch (err) { flash(err.message, true); }
          } }, "Remove"))) : h("li", { class: "muted" }, "No rules yet.")),
        h("div", { class: "row" }, ruleMatch, ruleSup, h("button", { onclick: async () => {
          try { await api("/api/ecom/rules", { body: { match: ruleMatch.value, supplier: ruleSup.value } }); flash("Rule saved."); refreshAfterSetup(); }
          catch (err) { flash(err.message, true); }
        } }, "Add rule")));
      box.replaceChildren(form, h("h2", {}, "Your warehouses"), list, rulesCard);
    } catch (err) { failed(box, err, () => openTab("warehouses", true)); }
  }

  function refreshAfterSetup() {
    delete loaded.overview; delete loaded.orders; delete loaded.routes; delete loaded.products;
    openTab("warehouses", true);
  }

  function warehouseForm(w) {
    const v = w || { kind: "logistics", active: true };
    const f = (id, label, val, ph, type) => [h("label", { for: id }, label), h("input", { id, value: val || "", placeholder: ph, type: type || "text" })];
    const kind = h("select", { id: "wh-kind" },
      h("option", { value: "logistics", selected: v.kind === "logistics" }, "Local logistics hub (delivers in its area)"),
      h("option", { value: "supplier", selected: v.kind === "supplier" }, "Supplier warehouse (products ship from here)"));
    const active = h("input", { type: "checkbox", id: "wh-active", checked: v.active !== false, style: "width:auto" });
    const form = h("form", { class: "card" },
      h("h2", {}, w ? `Edit ${w.name}` : "Add a warehouse"),
      h("label", { for: "wh-kind" }, "Type"), kind,
      ...f("wh-name", "Name", v.name, "e.g. Dallas Hub or CJ New Jersey"),
      ...f("wh-supplier", "Supplier (for supplier warehouses)", v.supplier, "e.g. CJ, Syncee, CROV"),
      ...f("wh-zip", "ZIP code", v.zip, "5-digit ZIP, e.g. 75201"),
      ...f("wh-address", "Street address (optional)", v.address, "e.g. 100 Commerce St"),
      ...f("wh-phone", "Phone (optional)", v.phone, "e.g. 214-555-0100", "tel"),
      ...f("wh-cats", "What it carries (optional)", v.categories, "e.g. Furniture, electronics"),
      h("label", { style: "display:flex;gap:8px;align-items:center" }, active, "Active (used for routing)"),
      h("div", { class: "links" }, h("button", { type: "submit" }, w ? "Save changes" : "Add warehouse"),
        w ? h("button", { type: "button", class: "ghost", onclick: () => form.remove() }, "Cancel") : null));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = (id) => form.querySelector(`#${id}`).value.trim();
      try {
        const r = await api("/api/ecom/warehouses", { body: { id: w ? w.id : "", kind: kind.value, name: val("wh-name"), supplier: val("wh-supplier"),
          zip: val("wh-zip"), address: val("wh-address"), phone: val("wh-phone"), categories: val("wh-cats"), active: active.checked } });
        flash(`Saved: ${r.place.city}, ${r.place.state}.`);
        refreshAfterSetup();
      } catch (err) { flash(err.message, true); }
    });
    return form;
  }

  // ---------- Products ----------
  let prodQuery = "";
  let prodOffset = 0;
  async function loadProducts(box) {
    loading(box);
    try {
      const d = await api(`/api/ecom/products?q=${encodeURIComponent(prodQuery)}&offset=${prodOffset}`);
      const search = h("input", { type: "search", placeholder: "Search your Ecwid products", value: prodQuery, "aria-label": "Search products" });
      const go = () => { prodQuery = search.value.trim(); prodOffset = 0; openTab("products", true); };
      search.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      const cards = d.items.map((p) => {
        const price = h("input", { type: "number", step: "0.01", min: "0", value: p.price, "aria-label": `Price of ${p.name}` });
        const qty = h("input", { type: "number", min: "0", value: p.unlimited ? "" : p.quantity, placeholder: p.unlimited ? "Unlimited" : "0", "aria-label": `Stock of ${p.name}` });
        const on = h("input", { type: "checkbox", checked: p.enabled, style: "width:auto", "aria-label": `${p.name} for sale` });
        const save = h("button", { onclick: async () => {
          save.disabled = true;
          const body = { enabled: on.checked };
          if (price.value !== "" && Number(price.value) !== Number(p.price)) body.price = Number(price.value);
          if (qty.value !== "" && Number(qty.value) !== Number(p.quantity)) body.quantity = parseInt(qty.value, 10);
          try { await api(`/api/ecom/products/${p.id}`, { body }); flash(`${p.name} saved.`); }
          catch (err) { flash(err.message, true); }
          save.disabled = false;
        } }, "Save");
        return h("article", { class: "card prod" },
          p.image ? h("img", { src: p.image, alt: "", loading: "lazy" }) : h("div", {}),
          h("div", {}, h("h3", {}, p.name), h("p", { class: "muted small" }, p.sku || "No SKU", " · ",
            p.supplier ? h("span", { class: "pill" }, p.supplier) : h("span", { class: "pill gold" }, "No supplier rule")),
            h("div", { class: "row" }, h("label", {}, "Price", price), h("label", {}, "Stock", qty)),
            h("div", { class: "row" }, h("label", { style: "display:flex;gap:8px;align-items:center" }, on, "For sale"), save)));
      });
      const pager = h("div", { class: "links" },
        prodOffset > 0 ? h("button", { class: "ghost", onclick: () => { prodOffset = Math.max(0, prodOffset - 50); openTab("products", true); } }, "← Previous") : null,
        prodOffset + 50 < d.total ? h("button", { class: "ghost", onclick: () => { prodOffset += 50; openTab("products", true); } }, "Next →") : null);
      box.replaceChildren(h("div", { class: "toolbar" }, search, h("button", { onclick: go }, "Search")),
        h("p", { class: "muted small" }, `${d.total} product${d.total === 1 ? "" : "s"}. Add new products and photos in Ecwid; change price, stock and on/off here.`),
        h("div", { class: "grid2" }, cards.length ? cards : [h("p", { class: "empty" }, "No products found.")]), pager);
    } catch (err) { failed(box, err, () => openTab("products", true)); }
  }

  // ---------- ZIP check ----------
  function loadZip(box) {
    const zip = h("input", { inputmode: "numeric", maxlength: "5", placeholder: "Customer ZIP code, e.g. 75024", "aria-label": "ZIP code" });
    const out = h("div");
    const go = async (e) => {
      e.preventDefault();
      out.replaceChildren(h("p", { class: "muted" }, "Checking..."));
      try {
        const d = await api(`/api/ecom/zip/${encodeURIComponent(zip.value.trim())}`);
        const table = (rows, empty) => rows.length ? h("ol", { class: "stops" }, rows.map((r) => h("li", {},
          h("strong", {}, r.name), r.supplier ? ` (${r.supplier})` : "", ` · ${r.city}, ${r.state} · ${r.miles} mi · ${r.days}`))) : h("p", { class: "muted" }, empty);
        out.replaceChildren(h("div", { class: "card" },
          h("h3", {}, `👉 ${d.place.city}, ${d.place.state} ${d.place.zip}`),
          h("p", { class: "small" }, h("strong", {}, "Nearest local hubs")), table(d.hubs, "No local hubs yet."),
          h("p", { class: "small" }, h("strong", {}, "Nearest supplier warehouses")), table(d.suppliers, "No supplier warehouses yet.")));
      } catch (err) { out.replaceChildren(h("p", { class: "error" }, err.message)); }
    };
    box.replaceChildren(h("form", { class: "card", onsubmit: go }, h("h2", {}, "Check delivery for a ZIP code"),
      h("p", { class: "muted small" }, "See which hub and supplier warehouses would serve a customer, and about how long delivery takes."),
      zip, h("button", { type: "submit" }, "Check")), out);
  }

  // ---------- Ask Claude ----------
  const chat = [];
  const SUGGEST = [
    "Which orders need attention today?",
    "Which CROV orders do I still need to place by hand?",
    "Where should my next local hub be?",
    "Write a short product description for a modern gray sofa.",
  ];
  // Shrink photos on the phone before sending (faster, cheaper): longest side 1568px, JPEG.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const dataUrl = c.toDataURL("image/jpeg", 0.85);
        resolve({ url: dataUrl, data: dataUrl.split(",")[1], type: "image/jpeg" });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }
  async function loadAsk(box) {
    loading(box);
    let ready = false;
    try { ready = (await api("/api/ecom/ask")).ready; } catch (err) { failed(box, err, () => openTab("ask", true)); return; }
    if (!ready) {
      box.replaceChildren(h("div", { class: "card setup" }, h("h2", {}, "Switch on Ask Claude"),
        h("ol", {}, h("li", {}, "Get an API key at console.anthropic.com (API Keys → Create Key). Set a monthly spending limit under Billing."),
          h("li", {}, "Render → cashcow-reviews-api → Environment: add ANTHROPIC_API_KEY with the key as the value."),
          h("li", {}, "Save, wait a minute, then tap Try again.")),
        h("button", { class: "ghost", onclick: () => openTab("ask", true) }, "Try again")));
      return;
    }
    const log = h("div", { class: "list", "aria-live": "polite" });
    const input = h("textarea", { rows: "3", placeholder: "Ask about your orders, routes, warehouses or products", "aria-label": "Your question" });
    const send = h("button", { type: "submit" }, "Ask");
    let photo = null; // { data, type, url }
    const preview = h("div");
    const camInput = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true,
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!file) return;
        try { photo = await shrink(file); showPhoto(); } catch { flash("That photo couldn't be opened. Try again.", true); }
      } });
    const libInput = h("input", { type: "file", accept: "image/*", hidden: true, onchange: camInput.onchange });
    libInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try { photo = await shrink(file); showPhoto(); } catch { flash("That photo couldn't be opened. Try again.", true); }
    });
    function showPhoto() {
      preview.replaceChildren(...(photo ? [h("div", { class: "ask-photo" },
        h("img", { src: photo.url, alt: "Photo to send" }),
        h("button", { type: "button", class: "danger", onclick: () => { photo = null; showPhoto(); } }, "Remove photo"))] : []));
    }
    function bubble(m) {
      return h("div", { class: m.role === "user" ? "card ask-q" : "card ask-a" },
        h("p", { class: "muted small", style: "margin:0 0 4px" }, m.role === "user" ? "You" : "✨ Claude"),
        m.photo ? h("img", { src: m.photo, alt: "Your photo", class: "ask-thumb" }) : null,
        h("div", { style: "white-space:pre-wrap" }, m.content));
    }
    function draw() { log.replaceChildren(...chat.map(bubble)); }
    async function ask(q) {
      q = (q || "").trim();
      if (!q && !photo) return;
      const history = chat.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const sent = photo;
      chat.push({ role: "user", content: q || "📷 What is in this photo?", photo: sent ? sent.url : null });
      input.value = ""; send.disabled = true; photo = null; showPhoto(); draw();
      const wait = h("p", { class: "muted" }, "Claude is reading your store data...");
      log.append(wait);
      try {
        const d = await api("/api/ecom/ask", { body: { question: q, history, image: sent ? sent.data : "", image_type: sent ? sent.type : "" } });
        chat.push({ role: "assistant", content: d.answer });
      } catch (err) {
        chat.pop(); flash(err.message, true); input.value = q; photo = sent; showPhoto();
      }
      send.disabled = false; draw();
      log.lastElementChild && log.lastElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const form = h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); ask(input.value); } },
      h("h2", {}, "Ask Claude"),
      h("p", { class: "muted small" }, "Snap a product, label, packing slip or invoice, or type a question. Claude reads your orders, warehouses and products (no customer names, addresses or phone numbers). It can't change anything; it tells you where to do it."),
      h("div", { class: "links" },
        h("button", { type: "button", class: "cam-btn", onclick: () => camInput.click() }, "📷 Take a photo"),
        h("button", { type: "button", class: "ghost", onclick: () => libInput.click() }, "🖼️ Choose a photo")),
      camInput, libInput, preview,
      input, h("div", { class: "links" }, send, chat.length ? h("button", { type: "button", class: "ghost", onclick: () => { chat.length = 0; draw(); } }, "Clear") : null),
      h("div", { class: "links" }, SUGGEST.map((t) => h("button", { type: "button", class: "ghost", style: "font-weight:500", onclick: () => ask(t) }, t))));
    box.replaceChildren(log, form);
    draw();
  }
})();
