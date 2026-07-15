function subtotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

function applyDiscount(rawRule, amount) {
  const rule = JSON.parse(rawRule);
  if (rule.kind === "percent") {
    return amount * (1 - rule.value / 100);
  }
  return amount - rule.value;
}

module.exports = { subtotal, applyDiscount };
