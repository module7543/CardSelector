// Browser tests only. Keep these invented merchants out of site/ and issuer captures.
const READ_DATE = "2026-10-18";

function offer(id, card, merchant, extra = {}) {
  return {
    id, card, merchant, category: "Clothing & Jewelry", bonus: "10% cash back",
    expires: null, expires_text: null, activation: "already_activated", channel: "in_store",
    spend_cap: null, minimum_spend: null, fine_print: null, other_details: [],
    last_read: READ_DATE, first_seen: READ_DATE, status: "active", status_since: READ_DATE,
    ...extra
  };
}

function offerBook(categories, offers) {
  const batches = [...new Set(offers.map(o => o.card))].map(card => ({ card, read_date: READ_DATE }));
  return { categories, batches, offers };
}

const usb = (slug, merchant, extra) => offer("us-bank/zqx-" + slug, "U.S. Bank", merchant, extra);
const pizza = { category: "Dining" };
const editOffers = {
  usbank: usb("outfitters", "Zqxedit Outfitters"),
  needs: usb("supplies", "Zqxedit Supplies", { activation: "needs_activation" }),
  chase: offer("chase-freedom-flex/zqx-booking", "Chase Freedom Flex", "Zqxbooking Shop", { activation: "needs_activation" }),
  capone: offer("capital-one/zqx-market", "Capital One", "Zqx Market", { activation: "none_shown", channel: "online" }),
  auto: offer("bank-of-america/zqx-value", "Bank of America", "Zqx Value Shop", { activation: "auto_enrolled" }),
  missing: offer("citi-double-cash/zqx-dropped", "Citi Double Cash", "Zqx Dropped Shop", { status: "missing" }),
  used: offer("citi-custom-cash/zqx-used", "Citi Custom Cash", "Zqx Used Shop", { status: "used" }),
  neighbor: offer("chase-freedom/zqx-booking", "Chase Freedom", "Zqxbooking Shop", { bonus: "1% cash back" })
};

const offlineOffers = {
  used: editOffers.usbank,
  restore: usb("restore", "Zqx Restore Shop"),
  conflict: usb("conflict", "Zqx Conflict Shop"),
  remembered: usb("remembered", "Zqx Remembered Shop"),
  held: usb("pizza-ember", "Zqx Pizza Ember", pizza),
  activate: editOffers.chase,
  retry: offer("chase-freedom/zqx-retry", "Chase Freedom", "Zqx Retry Shop", { activation: "needs_activation" })
};

function phoneOffers(categories) {
  // Enough distinct containers to exercise Show more and edits deep in the list.
  const longList = Array.from({ length: 205 }, (_, i) =>
    offer("capital-one/zqx-catalog-" + i, "Capital One", "Zqx Catalog Shop " + (i + 1),
      { activation: "none_shown", channel: "online" }));
  return offerBook(categories, [...Object.values(editOffers), ...longList]);
}

function savedCopyOffers(categories) {
  // Give the cache/open and viewport tests a stable set of in-store Dining results.
  const pizzas = ["Ash", "Birch", "Cedar", "Elm", "Fir", "Maple", "Oak", "Pine"].map((name, i) =>
    usb("pizza-" + name.toLowerCase(), "Zqx Pizza " + name, { ...pizza, bonus: (8 + i) + "% cash back" }));
  return offerBook(categories, [...Object.values(offlineOffers), ...pizzas]);
}

module.exports = { offer, offerBook, editOffers, offlineOffers, phoneOffers, savedCopyOffers };
