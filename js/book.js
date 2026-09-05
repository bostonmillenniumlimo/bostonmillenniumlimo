/* ============================================================
   Boston Millennium Limo — Booking / Trip Planner / Payment
   Free stack: Leaflet + OpenStreetMap + Nominatim + OSRM
   No API keys, no pay-per-use.
   ============================================================ */

/* ------------------------------------------------------------
   >>> CONFIG — EDIT THESE VALUES <<<
   These are SAMPLE rates so the estimator works out of the box.
   Replace them with Boston Millennium Limo's real pricing.
   ------------------------------------------------------------ */
var CONFIG = {
  // Per-vehicle pricing.  base = flat start fee, perMile = $/mile, min = minimum fare
  vehicles: {
    sedan:      { name: "Executive Sedan",  cap: "Up to 3",  base: 60,  perMile: 3.50, min: 75  },
    suv:        { name: "Luxury SUV",        cap: "Up to 6",  base: 75,  perMile: 4.25, min: 95  },
    sprinter:   { name: "Executive Sprinter",cap: "Up to 12", base: 120, perMile: 5.00, min: 175 },
    limo:       { name: "Stretch Limousine", cap: "Up to 10", base: 150, perMile: 6.00, min: 250 },
    stretchsuv: { name: "Stretch SUV",       cap: "Up to 14", base: 180, perMile: 6.50, min: 350 },
    partybus:   { name: "Party Bus",         cap: "Up to 20", base: 200, perMile: 7.00, min: 500 }
  },
  gratuityPct: 0,          // set e.g. 20 to auto-add 20% gratuity to the estimate
  depositPct: 25,          // deposit = this % of the estimated fare
  currency: "USD",
  currencySymbol: "$",

  // ---- ONLINE PAYMENT (optional) ----
  // PayPal: paste your PayPal *Business* account Client ID to switch on card/PayPal checkout.
  //   Get it free at https://developer.paypal.com  (My Apps & Credentials -> Live).
  paypalClientId: "",      // e.g. "Ae1a2b3c...."  — leave "" to keep payment switched off
  // Stripe (optional alternative): paste a Stripe Payment Link URL to show a "Pay by card" button.
  stripePaymentLink: "",   // e.g. "https://buy.stripe.com/xxxxxxxx"

  // Where reservation requests are sent. With an email set, the "Request Reservation"
  // button opens a pre-filled email to you. (For a nicer inbox form, wire it to Formspree — see SETUP.)
  bookingEmail: "bostonmilleniumlimo@gmail.com"  // reservation requests open a pre-filled email here
};
/* ---------------------- end config ------------------------- */

(function () {
  "use strict";
  if (!document.getElementById("trip-map")) return; // only run on booking page

  var BOSTON = [42.3601, -71.0589];
  var map, routeLayer, pickMarker, dropMarker;
  var pick = null, drop = null;          // {lat, lon, label}
  var routeMiles = null, routeMin = null;
  var selectedVehicle = "sedan";
  var tripType = "oneway";

  var sym = CONFIG.currencySymbol;

  /* ---------- Map ---------- */
  function initMap() {
    if (typeof L === "undefined" || !document.getElementById("trip-map")) return;
    map = L.map("trip-map", { scrollWheelZoom: false, zoomControl: true }).setView(BOSTON, 11);
    // Standard OpenStreetMap tiles (free, no API key). CSS inverts them to match the dark theme.
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      subdomains: "abc",
      maxZoom: 19,
      className: "map-tiles-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 300);
  }

  /* ---------- Geocoding (Nominatim) ---------- */
  var geoTimers = {};
  function geocode(query, cb) {
    var url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=" +
      encodeURIComponent(query);
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) { cb(data || []); })
      .catch(function () { cb([]); });
  }

  function attachAutocomplete(inputId, boxId, which) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(boxId);
    if (!input || !box) return;

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(geoTimers[which]);
      if (q.length < 3) { box.innerHTML = ""; box.hidden = true; return; }
      geoTimers[which] = setTimeout(function () {
        geocode(q, function (results) {
          if (!results.length) { box.hidden = true; return; }
          box.innerHTML = "";
          results.forEach(function (r) {
            var btn = document.createElement("button");
            btn.type = "button";
            var main = r.display_name.split(",")[0];
            btn.innerHTML = "<span>" + main + "</span> <span class='muted'>" +
              r.display_name.replace(main + ",", "").trim() + "</span>";
            btn.addEventListener("click", function () {
              input.value = r.display_name;
              box.hidden = true;
              setPoint(which, { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: r.display_name });
            });
            box.appendChild(btn);
          });
          box.hidden = false;
        });
      }, 400); // debounce — respects Nominatim's ~1 req/sec policy
    });

    document.addEventListener("click", function (e) {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
  }

  function setPoint(which, pt) {
    if (which === "pick") {
      pick = pt;
      if (map) {
        if (pickMarker) map.removeLayer(pickMarker);
        pickMarker = L.marker([pt.lat, pt.lon], { title: "Pickup" }).addTo(map).bindPopup("Pickup");
      }
    } else {
      drop = pt;
      if (map) {
        if (dropMarker) map.removeLayer(dropMarker);
        dropMarker = L.marker([pt.lat, pt.lon], { title: "Drop-off" }).addTo(map).bindPopup("Drop-off");
      }
    }
    if (pick && drop) drawRoute();
    else if (map) map.setView([pt.lat, pt.lon], 12);
  }

  /* ---------- Routing (OSRM public demo) ---------- */
  function drawRoute() {
    var url = "https://router.project-osrm.org/route/v1/driving/" +
      pick.lon + "," + pick.lat + ";" + drop.lon + "," + drop.lat +
      "?overview=full&geometries=geojson";
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.routes && data.routes.length) {
        var route = data.routes[0];
        routeMiles = route.distance / 1609.34;
        routeMin = route.duration / 60;
        if (map) {
          var coords = route.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
          if (routeLayer) map.removeLayer(routeLayer);
          routeLayer = L.polyline(coords, { color: "#a9c0e6", weight: 4, opacity: 0.9 }).addTo(map);
          map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
        }
      } else {
        fallbackRoute();
      }
      updateEstimate();
    }).catch(function () { fallbackRoute(); updateEstimate(); });
  }

  function fallbackRoute() {
    // Straight-line distance x 1.3 as a rough road estimate if routing is unavailable
    var R = 3958.8;
    var dLat = (drop.lat - pick.lat) * Math.PI / 180;
    var dLon = (drop.lon - pick.lon) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(pick.lat * Math.PI / 180) * Math.cos(drop.lat * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    routeMiles = d * 1.3;
    routeMin = routeMiles * 1.8; // ~33 mph avg guess
    if (map) {
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = L.polyline([[pick.lat, pick.lon], [drop.lat, drop.lon]],
        { color: "#a9c0e6", weight: 3, dashArray: "6 6", opacity: 0.8 }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    }
  }

  /* ---------- Fare estimate ---------- */
  function computeFare() {
    if (routeMiles == null) return null;
    var v = CONFIG.vehicles[selectedVehicle];
    var miles = routeMiles * (tripType === "round" ? 2 : 1);
    var fare = v.base + v.perMile * miles;
    fare = Math.max(fare, v.min);
    if (CONFIG.gratuityPct) fare += fare * CONFIG.gratuityPct / 100;
    return Math.round(fare);
  }

  function money(n) { return sym + Number(n).toLocaleString("en-US"); }

  function updateEstimate() {
    var wrap = document.getElementById("estimate");
    var empty = document.getElementById("estimate-empty");
    if (routeMiles == null) { wrap.hidden = true; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    var v = CONFIG.vehicles[selectedVehicle];
    var miles = routeMiles * (tripType === "round" ? 2 : 1);
    var fare = computeFare();
    document.getElementById("est-vehicle").textContent = v.name;
    document.getElementById("est-distance").textContent = miles.toFixed(1) + " mi" + (tripType === "round" ? " (round trip)" : "");
    document.getElementById("est-time").textContent = Math.round(routeMin) + " min each way";
    document.getElementById("est-fare").textContent = money(fare);
    wrap.hidden = false;
    renderPayment(fare);
  }

  /* ---------- Vehicle & trip-type pickers ---------- */
  function buildVehiclePicker() {
    var box = document.getElementById("veh-options");
    Object.keys(CONFIG.vehicles).forEach(function (key, i) {
      var v = CONFIG.vehicles[key];
      var el = document.createElement("div");
      el.className = "veh-opt" + (i === 0 ? " sel" : "");
      el.dataset.key = key;
      el.innerHTML = "<div class='vn'>" + v.name + "</div><div class='vc'>" + v.cap + " &middot; from " + money(v.min) + "</div>";
      el.addEventListener("click", function () {
        selectedVehicle = key;
        box.querySelectorAll(".veh-opt").forEach(function (o) { o.classList.remove("sel"); });
        el.classList.add("sel");
        updateEstimate();
      });
      box.appendChild(el);
    });
  }

  function bindTripType() {
    document.querySelectorAll("input[name='triptype']").forEach(function (r) {
      r.addEventListener("change", function () { tripType = r.value; updateEstimate(); });
    });
  }

  function bindSwap() {
    var btn = document.getElementById("swap-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var pi = document.getElementById("pickup-input");
      var di = document.getElementById("dropoff-input");
      var tv = pi.value; pi.value = di.value; di.value = tv;
      var tp = pick; pick = drop; drop = tp;
      if (map && pickMarker) map.removeLayer(pickMarker);
      if (map && dropMarker) map.removeLayer(dropMarker);
      pickMarker = dropMarker = null;
      if (pick) setPoint("pick", pick);
      if (drop) setPoint("drop", drop);
    });
  }

  /* ---------- Payment ---------- */
  var paypalLoaded = false;
  function renderPayment(fare) {
    var full = fare;
    var deposit = Math.round(fare * CONFIG.depositPct / 100);
    var fEl = document.getElementById("pay-full-amt");
    var dEl = document.getElementById("pay-deposit-amt");
    if (fEl) fEl.textContent = money(full);
    if (dEl) dEl.textContent = money(deposit) + " (" + CONFIG.depositPct + "%)";

    var container = document.getElementById("pay-container");
    var block = document.getElementById("deposit-block");
    if (!container) return;

    var hasPayPal = CONFIG.paypalClientId && CONFIG.paypalClientId.indexOf("PASTE") === -1 && CONFIG.paypalClientId.length > 10;
    var hasStripe = CONFIG.stripePaymentLink && CONFIG.stripePaymentLink.indexOf("http") === 0;

    // No provider configured -> hide the optional deposit block entirely.
    // Customers just use the reservation form; nothing "under construction" is shown.
    if (!hasPayPal && !hasStripe) { if (block) block.style.display = "none"; return; }
    if (block) block.style.display = "";

    container.innerHTML = "";
    var mode = (document.querySelector("input[name='paymode']:checked") || {}).value || "deposit";
    if (hasPayPal) { container.innerHTML += "<div id='paypal-buttons'></div>"; }
    if (hasStripe) {
      container.innerHTML +=
        "<a class='btn btn-primary btn-lg' style='width:100%' target='_blank' rel='noopener' href='" +
        CONFIG.stripePaymentLink + "'>Pay by Card</a>" +
        "<p class='est-note' style='text-align:center;margin-top:10px'>At secure checkout, enter your " +
        (mode === "full" ? "<strong>full fare</strong>" : "<strong>deposit</strong>") +
        " amount shown above. Payments handled securely by Stripe.</p>";
    }

    if (hasPayPal) loadPayPal(container);
  }

  function currentPayAmount() {
    var mode = (document.querySelector("input[name='paymode']:checked") || {}).value || "deposit";
    var fare = computeFare() || 0;
    return mode === "full" ? fare : Math.round(fare * CONFIG.depositPct / 100);
  }

  function loadPayPal(container) {
    function render() {
      var host = document.getElementById("paypal-buttons");
      if (!host || !window.paypal) return;
      host.innerHTML = "";
      window.paypal.Buttons({
        style: { color: "silver", shape: "rect", label: "pay", height: 46 },
        createOrder: function (data, actions) {
          return actions.order.create({
            purchase_units: [{
              amount: { value: String(currentPayAmount()) },
              description: "Boston Millennium Limo reservation"
            }]
          });
        },
        onApprove: function (data, actions) {
          return actions.order.capture().then(function () {
            var host2 = document.getElementById("pay-container");
            host2.innerHTML = "<div class='pay-disabled'><strong>Thank you — payment received.</strong><br>" +
              "We'll confirm your reservation by phone or email shortly.</div>";
          });
        }
      }).render("#paypal-buttons");
    }
    if (paypalLoaded && window.paypal) { render(); return; }
    var s = document.createElement("script");
    s.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(CONFIG.paypalClientId) +
      "&currency=" + CONFIG.currency + "&intent=capture";
    s.onload = function () { paypalLoaded = true; render(); };
    document.head.appendChild(s);
  }

  /* ---------- Reservation form ---------- */
  function bindReserveForm() {
    var form = document.getElementById("reserve-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var note = document.getElementById("reserve-note");
      var g = function (id) { var el = document.getElementById(id); return el ? el.value : ""; };
      var v = CONFIG.vehicles[selectedVehicle];
      var fare = computeFare();
      var body = [
        "New reservation request — Boston Millennium Limo", "",
        "Name: " + g("r-name"),
        "Phone: " + g("r-phone"),
        "Email: " + g("r-email"),
        "Trip: " + (tripType === "round" ? "Round trip" : "One-way"),
        "Pickup: " + g("pickup-input"),
        "Destination: " + g("dropoff-input"),
        "Date / Time: " + g("b-date") + " " + g("b-time"),
        "Passengers: " + g("b-pass") + "   Luggage: " + g("b-lug"),
        "Vehicle: " + (v ? v.name : ""),
        "Flight #: " + g("r-flight"),
        "Estimated fare: " + (fare != null ? money(fare) : "n/a"),
        "Notes: " + g("r-notes")
      ].join("\n");

      if (CONFIG.bookingEmail) {
        window.location.href = "mailto:" + CONFIG.bookingEmail +
          "?subject=" + encodeURIComponent("Reservation request — " + g("r-name")) +
          "&body=" + encodeURIComponent(body);
        if (note) { note.style.display = "block"; note.textContent = "Opening your email app to send the request…"; }
      } else if (note) {
        note.style.display = "block";
        note.textContent = "Thank you! Please call (617) 870-1416 to lock in your reservation — we'll confirm your date and final rate.";
      }
    });
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    try { initMap(); } catch (e) { /* map optional — page still works */ }
    buildVehiclePicker();
    bindTripType();
    bindSwap();
    bindReserveForm();
    attachAutocomplete("pickup-input", "pickup-suggest", "pick");
    attachAutocomplete("dropoff-input", "dropoff-suggest", "drop");
    document.querySelectorAll("input[name='paymode']").forEach(function (r) {
      r.addEventListener("change", function () { renderPayment(computeFare() || 0); });
    });
  });
})();
