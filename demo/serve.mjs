// Demo shop for the pitch. `node demo/serve.mjs` = good version, `BROKEN=1 node demo/serve.mjs` = planted regression.
// The regression: a "harmless" refactor of the price helper breaks the discount code, nothing else.
import http from "node:http";
const PORT = Number(process.env.PORT ?? 4321);
const BROKEN = process.env.BROKEN === "1";

const layout = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} · Bean There</title>
<style>body{font-family:system-ui;margin:0;background:#faf7f2;color:#222}nav{display:flex;gap:18px;padding:16px 28px;background:#3b2a1e}
nav a{color:#f5e6d3;text-decoration:none;font-weight:600}main{padding:28px;max-width:760px}
.p{background:#fff;border-radius:10px;padding:16px;margin:12px 0;display:flex;justify-content:space-between;align-items:center}
button{background:#3b2a1e;color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer}input,textarea{padding:8px;border:1px solid #ccc;border-radius:6px;width:100%;box-sizing:border-box;margin:4px 0 10px}</style></head>
<body><nav><a href="/">Home</a><a href="/shop">Shop</a><a href="/cart">Cart (<span data-testid="cart-count">0</span>)</a><a href="/contact">Contact</a></nav><main>${body}</main>
<script>
const cart=()=>JSON.parse(localStorage.getItem("cart")||"[]");
document.querySelector('[data-testid=cart-count]').textContent=cart().length;
</script></body></html>`;

const products = [["Ethiopia Yirgacheffe", 14.5], ["Colombia Huila", 12.0], ["House Espresso", 11.0]];

const pages = {
  "/": () => layout("Home", `<h1>Fresh roasted coffee, delivered</h1><p>Small-batch beans from a tiny roastery.</p><a href="/shop"><button>Shop beans</button></a>`),
  "/shop": () => layout("Shop", `<h1>Shop</h1>${products.map(([n, p], i) => `<div class="p"><div><b>${n}</b><br>€${p.toFixed(2)}</div>
<button data-testid="add-${i}" onclick='const c=JSON.parse(localStorage.getItem("cart")||"[]");c.push(${i});localStorage.setItem("cart",JSON.stringify(c));document.querySelector("[data-testid=cart-count]").textContent=c.length;document.getElementById("msg").textContent="Added to cart"'>Add to cart</button></div>`).join("")}
<p id="msg" role="status"></p>`),
  "/cart": () => layout("Cart", `<h1>Your cart</h1><div id="lines"></div><p>Total: <b data-testid="total">€0.00</b></p>
<label for="code">Discount code</label><input id="code" name="code" placeholder="e.g. WELCOME10"><button data-testid="apply" onclick="apply()">Apply</button>
<p id="note" role="status"></p><button data-testid="checkout" onclick="location.href='/checkout'">Checkout</button>
<script>
const P=${JSON.stringify(products)};
let pct=0;
${BROKEN
  // Refactor "cleanup": percentage now applied as a fraction twice -> discount silently does nothing visible + wrong total
  ? `const price=(sum,p)=>Math.round(sum*(1-p/100/100)*100)/100;`
  : `const price=(sum,p)=>Math.round(sum*(1-p/100)*100)/100;`}
function render(){const c=JSON.parse(localStorage.getItem("cart")||"[]");document.getElementById("lines").innerHTML=c.map(i=>"<div class=p>"+P[i][0]+"<span>€"+P[i][1].toFixed(2)+"</span></div>").join("");
const sum=c.reduce((s,i)=>s+P[i][1],0);document.querySelector("[data-testid=total]").textContent="€"+price(sum,pct).toFixed(2);}
function apply(){const v=document.getElementById("code").value.trim().toUpperCase();if(v==="WELCOME10"){pct=10;document.getElementById("note").textContent="10% off applied";}else{document.getElementById("note").textContent="Code not valid";}render();}
render();
</script>`),
  "/checkout": () => layout("Checkout", `<h1>Checkout</h1><p>Order summary</p><p>Payment is disabled in this demo.</p>`),
  "/contact": () => layout("Contact", `<h1>Contact us</h1><form onsubmit="event.preventDefault();this.outerHTML='<p role=status>Thanks! We will reply within a day.</p>'">
<label for="name">Name</label><input id="name" name="name"><label for="email">Email</label><input id="email" name="email" type="email">
<label for="message">Message</label><textarea id="message" name="message"></textarea><button type="submit">Send message</button></form>`),
};

http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "") || "/";
  const page = pages[path];
  res.writeHead(page ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page ? page() : layout("Not found", "<h1>Not found</h1>"));
}).listen(PORT, () => console.log(`Bean There demo shop on http://localhost:${PORT}${BROKEN ? "  (BROKEN build)" : ""}`));
