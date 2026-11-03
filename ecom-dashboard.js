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
  const TABS = { overview: loadOverview, orders: loadOrders, routes: loadRoutes, warehouses: loadWarehouses, products: loadProducts, zip: loadZip, ask: loadAsk, toorder: loadToOrder, auto: loadAuto, candy: loadCandy };
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
        h("div", { class: "card" }, h("h3", {}, "Paid sales by channel, last 30 days"),
          (d.by_channel || []).length ? h("div", { class: "bars chan-bars" }, (() => {
            const top = Math.max(1, ...d.by_channel.map((c) => c[1][1]));
            return d.by_channel.map(([name, [n, amt]]) => h("div", { class: "bar" }, h("span", {}, name),
              h("i", { style: `width:${Math.round((amt / top) * 100)}%` }), h("em", {}, `${money(amt)} · ${n}`)));
          })()) : h("p", { class: "muted" }, "No paid sales yet. Turn on channels in Ecwid → Sales channels.")),
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
        h("span", {}, h("span", { class: "pill chan" }, o.channel || "Online store"), " ", h("span", { class: paid ? "pill good" : "pill gold" }, paid ? "Paid" : (o.payment || "Unpaid").replace(/_/g, " ").toLowerCase()), " ",
          h("span", { class: "pill" }, STATUS[o.status] || o.status))),
      h("p", { class: "muted small" }, when(o.created), " · ", money(o.total), o.phone ? ` · ${o.phone}` : ""),
      h("p", { class: "small" }, o.address || "No shipping address",
        !o.zip_found ? h("span", { class: "pill bad" }, " ZIP not found") : null),
      h("p", { class: "small" }, "🚚 Local hub: ", o.hub ? h("strong", {}, `${o.hub.name}`, o.hub.miles != null ? ` · ${o.hub.miles} mi` : "") : h("span", { class: "pill gold" }, "none yet")),
      h("ul", { class: "items" }, o.items.map((i) => h("li", {},
        h("strong", {}, `${i.quantity} × ${i.name}`), i.sku ? ` (${i.sku})` : "", h("br"),
        i.by_hand ? [h("span", { class: "pill gold" }, `Order by hand from ${i.supplier}`), " "] : null,
        i.auto ? [h("span", { class: "pill good" }, `Sent to ${i.supplier} automatically`), " "] : null,
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
            p.ribbon ? h("p", { class: "small", style: "margin:4px 0 0" }, h("span", { class: "pill good" }, p.ribbon)) : null,
            h("div", { class: "row" }, h("label", {}, "Price", price), h("label", {}, "Stock", qty)),
            h("div", { class: "row" }, h("label", { style: "display:flex;gap:8px;align-items:center" }, on, "For sale"), save)));
      });
      const pager = h("div", { class: "links" },
        prodOffset > 0 ? h("button", { class: "ghost", onclick: () => { prodOffset = Math.max(0, prodOffset - 50); openTab("products", true); } }, "← Previous") : null,
        prodOffset + 50 < d.total ? h("button", { class: "ghost", onclick: () => { prodOffset += 50; openTab("products", true); } }, "Next →") : null);
      const ribBtn = h("button", { class: "ghost", onclick: async () => {
        ribBtn.disabled = true; ribBtn.textContent = "Adding ribbons...";
        try { const r = await api("/api/ecom/ribbons", { method: "POST" }); flash(r.message); openTab("products", true); }
        catch (err) { flash(err.message, true); ribBtn.disabled = false; ribBtn.textContent = "📍 Add \"Ships from\" ribbons now"; }
      } }, "📍 Add \"Ships from\" ribbons now");
      let sections = [];
      try { sections = (await api("/api/ecom/sections")).sections; } catch { /* optional */ }
      const sectionCard = sections.length ? h("div", { class: "card" }, h("h3", {}, "Store sections"),
        h("p", { class: "muted small" }, "One tap builds the section and its shelves in your Ecwid store. Then add products to the shelves (Ask Claude can do it from a photo)."),
        h("div", { class: "grid2" }, sections.map((sec) => {
          const b = h("button", { class: "ghost", onclick: async () => {
            b.disabled = true; b.textContent = "Building...";
            try { const r = await api(`/api/ecom/sections/${sec.key}`, { method: "POST" }); flash(r.message); b.textContent = "✅ Ready"; }
            catch (err) { flash(err.message, true); b.disabled = false; b.textContent = `Build ${sec.name}`; }
          } }, `Build ${sec.name}`);
          return h("div", { class: "section-tile" }, h("p", { style: "margin:0;font-weight:700" }, `${sec.icon} ${sec.name}`),
            h("p", { class: "muted small", style: "margin:4px 0 8px" }, sec.shelves.join(" · ")), b);
        }))) : null;
      let cjCard = null;
      try { cjCard = await cjFiller(); } catch { /* optional */ }
      box.replaceChildren(h("div", { class: "toolbar" }, search, h("button", { onclick: go }, "Search")), sectionCard, cjCard,
        h("div", { class: "card" }, h("p", { class: "small", style: "margin:0 0 8px" },
          "Each product's picture shows where it ships from, like \"📍 From Cranbury, NJ 08512\", so nearby customers know it arrives fast. It comes from the product's supplier warehouse and updates every hour on its own."), ribBtn),
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
    "Set up my warehouses and SKU rules for CJ (Cranbury, NJ 08512) and CROV.",
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
        h("div", { style: "white-space:pre-wrap" }, m.content),
        (m.actions || []).map((a) => actionCard(a, m)));
    }
    function draw() { log.replaceChildren(...chat.map(bubble)); }
    function actionCard(a, m) {
      const done = a.state === "done", skipped = a.state === "skipped";
      const box = h("div", { class: "action" + (done ? " done" : "") },
        h("p", { style: "margin:0 0 8px;font-weight:600" }, done ? "✅ " : skipped ? "⏭️ " : "👉 ", a.summary),
        a.type === "create_product" && a.input.description ? h("p", { class: "muted small", style: "margin:0 0 8px" }, a.input.description) : null,
        a.result ? h("p", { class: a.error ? "error" : "small", style: "margin:0 0 8px" }, a.result) : null,
        !done && !skipped ? h("div", { class: "links" },
          h("button", { type: "button", onclick: async (e) => {
            e.target.disabled = true;
            try {
              const photoOk = a.type === "create_product" && a.input.use_photo && m.sentPhoto;
              const r = await api("/api/ecom/action", { body: { type: a.type, input: a.input,
                image: photoOk ? m.sentPhoto.data : "", image_type: photoOk ? m.sentPhoto.type : "" } });
              a.state = "done"; a.result = r.message || "Done."; a.error = false;
              ["overview", "orders", "routes", "warehouses", "products", "toorder"].forEach((k) => delete loaded[k]);
            } catch (err) { a.result = err.message; a.error = true; }
            draw();
          } }, "Confirm"),
          h("button", { type: "button", class: "ghost", onclick: () => { a.state = "skipped"; draw(); } }, "Skip")) : null);
      return box;
    }
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
        chat.push({ role: "assistant", content: d.answer, actions: (d.actions || []).map((a) => ({ ...a, state: "new" })), photo: null, sentPhoto: sent });
      } catch (err) {
        chat.pop(); flash(err.message, true); input.value = q; photo = sent; showPhoto();
      }
      send.disabled = false; draw();
      log.lastElementChild && log.lastElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const form = h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); ask(input.value); } },
      h("h2", {}, "Ask Claude"),
      h("p", { class: "muted small" }, "Snap a product, label, packing slip or invoice, or type a question. Claude reads your orders, warehouses and products (no customer names, addresses or phone numbers). When it can set something up for you, it shows a Confirm button. Nothing changes until you tap it."),
      h("div", { class: "links" },
        h("button", { type: "button", class: "cam-btn", onclick: () => camInput.click() }, "📷 Take a photo"),
        h("button", { type: "button", class: "ghost", onclick: () => libInput.click() }, "🖼️ Choose a photo")),
      camInput, libInput, preview,
      input, h("div", { class: "links" }, send, chat.length ? h("button", { type: "button", class: "ghost", onclick: () => { chat.length = 0; draw(); } }, "Clear") : null),
      h("div", { class: "links" }, SUGGEST.map((t) => h("button", { type: "button", class: "ghost", style: "font-weight:500", onclick: () => ask(t) }, t))));
    box.replaceChildren(log, form);
    draw();
  }

  // ---------- To order ----------
  async function loadToOrder(box) {
    loading(box);
    try {
      const d = await api("/api/ecom/to-order");
      if (!d.groups.length) {
        box.replaceChildren(h("div", { class: "card empty" }, "✅ Nothing to order right now. New paid orders show up here."),
          h("button", { class: "ghost", onclick: () => openTab("toorder", true) }, "Refresh"));
        return;
      }
      box.replaceChildren(
        h("p", { class: "muted small" }, "Paid orders you still need to place with each supplier. Copy the address, order it on the supplier's site, then tap Mark ordered."),
        ...d.groups.map((g) => h("div", {},
          h("h2", {}, `${g.supplier} · ${g.orders.length} order${g.orders.length === 1 ? "" : "s"}`),
          h("div", { class: "list" }, g.orders.map((o) => {
            const ref = h("input", { placeholder: `${g.supplier} order number (optional)`, "aria-label": "Supplier order number" });
            return h("article", { class: "card" },
              h("div", { class: "order-head" }, h("h3", {}, `#${o.number}`),
                h("span", { class: "muted small" }, h("span", { class: "pill chan" }, o.channel || "Online store"), " ", when(o.created))),
              h("ul", { class: "items" }, o.items.map((i) => h("li", {}, h("strong", {}, `${i.quantity} × ${i.name}`), i.sku ? ` · SKU ${i.sku}` : "",
                i.ships_from ? h("span", { class: "muted small" }, ` · from ${i.ships_from.name}`) : null))),
              h("pre", { class: "shipto" }, o.ship_to || o.address || "No address"),
              h("div", { class: "links" },
                h("button", { class: "ghost", onclick: async () => {
                  try { await navigator.clipboard.writeText(o.ship_to || o.address); flash("Address copied."); } catch { flash("Couldn't copy. Press and hold the address to copy it.", true); }
                } }, "📋 Copy address"),
                g.supplier.toUpperCase() === "CROV" ? h("a", { href: "https://www.crov.com", target: "_blank", rel: "noopener" }, "Open CROV") : null),
              h("div", { class: "row" }, ref, h("button", { onclick: async (e) => {
                e.target.disabled = true;
                try { await api(`/api/ecom/orders/${encodeURIComponent(o.id)}/ordered`, { body: { supplier: g.supplier, ref: ref.value } });
                  flash(`#${o.number} marked as ordered from ${g.supplier}.`); delete loaded.overview; openTab("toorder", true); }
                catch (err) { flash(err.message, true); e.target.disabled = false; }
              } }, "✅ Mark ordered")));
          })))));
    } catch (err) { failed(box, err, () => openTab("toorder", true)); }
  }

  // ---------- Automation ----------
  async function loadAuto(box) {
    loading(box);
    try {
      const d = await api("/api/ecom/automation");
      const row = (sw) => {
        const id = `sw-${sw.key}`;
        const input = h("input", { type: "checkbox", id, role: "switch", checked: sw.on, disabled: !!sw.blocked && !sw.on,
          onchange: async (e) => {
            const on = e.target.checked; e.target.disabled = true;
            try { await api("/api/ecom/automation", { body: { key: sw.key, on } }); flash(`${sw.label}: ${on ? "on" : "off"}.`); }
            catch (err) { e.target.checked = !on; flash(err.message, true); }
            e.target.disabled = false;
          } });
        return h("div", { class: "switch-row" + (sw.blocked && !sw.on ? " locked" : "") },
          h("label", { class: "switch", for: id }, input, h("span", { class: "slider", "aria-hidden": "true" })),
          h("div", {}, h("label", { for: id, class: "switch-label" }, sw.label),
            h("p", { class: "muted small", style: "margin:2px 0 0" }, sw.about),
            sw.blocked ? h("p", { class: "small", style: "margin:4px 0 0;color:var(--warn)" }, "🔒 ", sw.blocked) : null));
      };
      const lr = d.last_run || {};
      const runBtn = h("button", { onclick: async () => {
        runBtn.disabled = true;
        try { const r = await api("/api/ecom/automation/run", { method: "POST" });
          flash(r.error ? `Check finished with a problem: ${r.error}` : `Check done: ${r.processed} new order${r.processed === 1 ? "" : "s"} processed.`, !!r.error);
          ["overview", "orders", "routes", "toorder"].forEach((k) => delete loaded[k]); openTab("auto", true);
        } catch (err) { flash(err.message, true); runBtn.disabled = false; }
      } }, "▶️ Check for new orders now");
      box.replaceChildren(
        h("div", { class: "card" }, h("h2", {}, "Your order pipeline"),
          h("ol", { class: "stops" },
            h("li", {}, "Customer pays in your Ecwid store."),
            h("li", {}, `Every ${d.every_minutes} minutes the dashboard picks up new paid orders and routes them to the nearest warehouse and hub.`),
            h("li", {}, "The order is marked Processing and lands on your 📦 To order list."),
            h("li", {}, "You place it with the supplier and tap Mark ordered."),
            h("li", {}, "You add tracking in Orders; Ecwid emails the customer.")),
          h("p", { class: "muted small" }, lr.at ? `Last check: ${new Date(lr.at).toLocaleString()} · ${lr.processed || 0} new` + (lr.error ? ` · problem: ${lr.error}` : "") : "No check has run yet."),
          runBtn),
        h("div", { class: "card" }, h("h2", {}, "Working now (free)"), d.switches.filter((x) => x.group === "free").map(row)),
        ...d.switches.filter((x) => x.group === "channels").map((sw) => h("div", { class: "card" },
          h("h2", {}, "🐙 Sales channels"),
          h("p", {}, sw.about),
          h("ol", { class: "stops" },
            h("li", {}, "Open Ecwid and tap the menu (☰)."),
            h("li", {}, "Tap Sales channels."),
            h("li", {}, "Turn on each channel and follow its short setup.")),
          h("div", { class: "links" }, h("a", { href: "https://my.ecwid.com/", target: "_blank", rel: "noopener" }, "Open Ecwid")))),
        h("div", { class: "card" }, h("h2", {}, "Upgrades for later"),
          h("p", { class: "muted small" }, "These unlock as you grow. Each one stays locked until what it needs is set up."),
          d.switches.filter((x) => x.group === "upgrade").map(row)));
    } catch (err) { failed(box, err, () => openTab("auto", true)); }
  }

  // ---------- The Candy Lady ----------
  async function loadCandy(box) {
    loading(box);
    try {
      const d = await api("/api/candy/admin");
      const st = d.settings;
      const disc = h("input", { type: "number", min: "0", max: "50", step: "0.5", value: st.candy_discount, "aria-label": "Customer discount percent" });
      const cut = h("input", { type: "number", min: "0", max: "50", step: "0.5", value: st.candy_cut, "aria-label": "Candy Lady cut percent" });
      const bonus = h("input", { type: "number", min: "0", max: "100", step: "1", value: st.candy_credit_bonus ?? 20, "aria-label": "Store credit bonus percent" });
      const url = h("input", { type: "url", value: st.candy_url || "", placeholder: "https://...company.site/Candy-Lady-c123", "aria-label": "Candy Lady store link" });
      const joinLink = "https://cashcow-ecommerce.onrender.com/candylady.html";
      const sellerCard = (x) => h("article", { class: "card" },
        h("div", { class: "order-head" }, h("h3", {}, `${x.name} · ${x.code}`),
          h("span", {}, x.waiting ? h("span", { class: "pill gold" }, "⏳ Code waiting for Ecwid Venture plan") : null, " ",
            h("span", { class: x.status === "active" ? "pill good" : "pill bad" }, x.status === "active" ? "Active" : "Paused"))),
        h("p", { class: "muted small" }, x.email, x.phone ? ` · ${x.phone}` : "", ` · pays by ${x.payout_method || "?"} ${x.payout_handle || ""}`),
        h("p", { class: "small" }, `${x.orders} order${x.orders === 1 ? "" : "s"} · owed ${money(x.owed)} · on the way ${money(x.pending)} · paid ${money(x.paid)}`),
        h("div", { class: "links" },
          x.owed > 0 ? h("button", { onclick: async (e) => {
            const ask = x.credit != null
              ? `Create a one-time store credit code worth ${money(x.credit)} for ${x.name} and email it to her?`
              : `Did you pay ${x.name} ${money(x.owed)} by ${x.payout_method} (${x.payout_handle || "no handle"})?`;
            if (!confirm(ask)) return;
            e.target.disabled = true;
            try { const r = await api(`/api/candy/admin/sellers/${x.id}/paid`, { method: "POST" }); flash(r.message); openTab("candy", true); }
            catch (err) { flash(err.message, true); e.target.disabled = false; }
          } }, x.credit != null ? `🎁 Send ${money(x.credit)} store credit` : `✅ Mark ${money(x.owed)} paid`) : null,
          h("button", { class: x.status === "active" ? "danger" : "ghost", onclick: async () => {
            try { const r = await api(`/api/candy/admin/sellers/${x.id}`, { body: { status: x.status === "active" ? "paused" : "active" } }); flash(r.message); openTab("candy", true); }
            catch (err) { flash(err.message, true); }
          } }, x.status === "active" ? "Pause code" : "Turn code back on")));
      box.replaceChildren(
        h("div", { class: "card" }, h("h2", {}, "🍬 The Candy Lady"),
          h("p", { class: "small" }, "Anyone can join free at the page below, get a code, and share it. Customers save with the code; the Candy Lady earns a cut once the order ships."),
          h("div", { class: "links" },
            h("a", { href: joinLink, target: "_blank", rel: "noopener" }, "Open the join page"),
            h("button", { class: "ghost", onclick: async () => { try { await navigator.clipboard.writeText(joinLink); flash("Join link copied."); } catch { flash(joinLink); } } }, "📋 Copy join link"))),
        h("div", { class: "card" }, h("h3", {}, `Who to pay (${money(d.min_payout)} or more owed)`),
          d.to_pay.length ? h("div", { class: "list" }, d.to_pay.map(sellerCard)) : h("p", { class: "muted" }, "Nobody is due a payout right now.")),
        h("div", { class: "card" }, h("h3", {}, "Rates and store link"),
          h("div", { class: "row" }, h("label", {}, "Customer discount %", disc), h("label", {}, "Candy Lady cut %", cut), h("label", {}, "Store credit bonus %", bonus)),
          h("label", {}, "Link to your Candy Lady products in Ecwid (shared with each code)", url),
          h("button", { style: "margin-top:10px", onclick: async () => {
            try { const r = await api("/api/candy/admin/settings", { body: { discount: Number(disc.value), cut: Number(cut.value), url: url.value.trim(), bonus: Number(bonus.value) } }); flash(r.message); }
            catch (err) { flash(err.message, true); }
          } }, "Save")),
        h("h2", {}, `All Candy Ladies (${d.sellers.length})`),
        h("div", { class: "list" }, d.sellers.length ? d.sellers.map(sellerCard) : [h("p", { class: "empty" }, "No Candy Ladies yet. Share the join page!")]));
    } catch (err) { failed(box, err, () => openTab("candy", true)); }
  }

  // ---------- Fill shelves from CJ ----------
  async function cjFiller() {
    const st = await api("/api/ecom/cj");
    if (!st.ready) {
      return h("div", { class: "card setup" }, h("h3", {}, "🛒 Fill shelves from CJ automatically"),
        h("ol", {}, h("li", {}, "Sign up free at cjdropshipping.com and copy your API key (account → API)."),
          h("li", {}, "Render → cashcow-reviews-api → Environment: add CJ_API_KEY with the key."),
          h("li", {}, "Save, wait a minute, and reload this page.")));
    }
    const shelf = h("select", { "aria-label": "Shelf" }, st.shelves.map((x) => h("option", { value: x.path }, `${x.icon} ${x.section} › ${x.shelf}`)));
    const kw = h("input", { placeholder: "Search words (optional)", "aria-label": "Search words" });
    const mk = h("input", { type: "number", min: "1.1", max: "10", step: "0.1", value: st.markup, "aria-label": "Markup" });
    const out = h("div");
    const log = h("div", { class: "small", "aria-live": "polite" });
    async function importItems(path, items, onEach) {
      let added = 0;
      for (let i = 0; i < items.length; i += 3) {
        const batch = items.slice(i, i + 3);
        try {
          const r = await api("/api/ecom/cj/import", { body: { shelf: path, items: batch.map((x) => ({ pid: x.pid, price: x.price })) } });
          r.results.forEach((x) => onEach(x)); added += r.added;
        } catch (err) { batch.forEach((x) => onEach({ pid: x.pid, ok: false, message: err.message })); }
      }
      return added;
    }
    async function doSearch() {
      out.replaceChildren(h("p", { class: "muted" }, "Searching CJ's US warehouses... (about 5 seconds)"));
      try {
        const d = await api("/api/ecom/cj/search", { body: { shelf: shelf.value, keyword: kw.value, markup: Number(mk.value), limit: 12 } });
        if (!d.items.length) { out.replaceChildren(h("p", { class: "muted" }, "Nothing in US stock for that. Try other search words.")); return; }
        let picked = 0;
        const rows = d.items.map((x) => {
          const on = h("input", { type: "checkbox", checked: !x.in_store && picked++ < 6, disabled: x.in_store, style: "width:auto" });
          const pr = h("input", { type: "number", step: "0.01", min: String(x.cost), value: x.price, "aria-label": `Price for ${x.name}`, style: "max-width:110px" });
          const status = h("span", { class: "small" });
          return { x, on, pr, status, el: h("label", { class: "card prod", style: "cursor:pointer" },
            x.image ? h("img", { src: x.image, alt: "", loading: "lazy" }) : h("div"),
            h("div", {}, h("p", { style: "margin:0;font-weight:600" }, on, " ", x.name),
              h("p", { class: "muted small", style: "margin:4px 0" }, `CJ cost $${x.cost.toFixed(2)} · ${x.us_stock} in US stock`, x.in_store ? " · already in your store" : ""),
              h("div", { class: "row", style: "align-items:center" }, h("span", { class: "small" }, "Your price $"), pr, status))) };
        });
        const add = h("button", { onclick: async () => {
          const chosen = rows.filter((r) => r.on.checked);
          if (!chosen.length) { flash("Tick at least one product.", true); return; }
          add.disabled = true; add.textContent = `Adding ${chosen.length}...`;
          const n = await importItems(shelf.value, chosen.map((r) => ({ pid: r.x.pid, price: Number(r.pr.value) })), (res) => {
            const r = rows.find((y) => y.x.pid === res.pid); if (!r) return;
            r.status.textContent = res.ok ? " ✅ Added" : ` ⚠️ ${res.message}`; r.on.checked = false; r.on.disabled = res.ok;
          });
          flash(`${n} product${n === 1 ? "" : "s"} added to ${shelf.value}.`); add.disabled = false; add.textContent = "Add ticked products";
          delete loaded.overview;
        } }, "Add ticked products");
        out.replaceChildren(h("p", { class: "muted small" }, "Ticked items go live in your store with photo, description, shelf and ribbon. Change any price first if you like."),
          h("div", { class: "grid2" }, rows.map((r) => r.el)), h("div", { class: "links" }, add));
      } catch (err) { out.replaceChildren(h("p", { class: "error" }, err.message)); }
    }
    const auto = h("button", { class: "ghost", onclick: async () => {
      if (!confirm(`Fill every shelf automatically with up to 3 US-stock CJ products each, priced at cost × ${mk.value}? This takes a few minutes; keep this page open.`)) return;
      auto.disabled = true; log.replaceChildren();
      let total = 0;
      for (const x of st.shelves) {
        const line = h("p", { style: "margin:2px 0" }, `${x.icon} ${x.shelf}: searching...`); log.append(line);
        try {
          const d = await api("/api/ecom/cj/search", { body: { shelf: x.path, markup: Number(mk.value), limit: 6 } });
          const pick = d.items.filter((i) => !i.in_store).slice(0, 3);
          if (!pick.length) { line.textContent = `${x.icon} ${x.shelf}: nothing new in US stock`; continue; }
          const n = await importItems(x.path, pick, () => {});
          total += n; line.textContent = `${x.icon} ${x.shelf}: ✅ ${n} added`;
        } catch (err) { line.textContent = `${x.icon} ${x.shelf}: ⚠️ ${err.message}`; }
      }
      flash(`Done: ${total} products added across your shelves.`); auto.disabled = false; delete loaded.overview;
    } }, "⚡ Auto-fill every shelf (3 each)");
    return h("div", { class: "card" }, h("h3", {}, "🛒 Fill shelves from CJ"),
      h("p", { class: "muted small" }, "Finds products stocked in CJ's US warehouses for a shelf, prices them with your markup (rounded to .99), and adds the ones you tick."),
      h("label", {}, "Shelf", shelf),
      h("div", { class: "row" }, h("label", {}, "Search words", kw), h("label", {}, "Markup (× CJ cost)", mk)),
      h("div", { class: "links" }, h("button", { onclick: doSearch }, "🔍 Find products"), auto), log, out);
  }
})();
