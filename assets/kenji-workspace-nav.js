/* Shared, predictable navigation for KENJI AI Workspace pages. */
(() => {
  const path = location.pathname;
  const links = [
    {label:"Home", href:"/workspace/", match:p=>p==="/workspace/"||p==="/workspace/index.html"},
    {label:"AI Customer Reply", href:"/ai-customer-reply.html", match:p=>p==="/ai-customer-reply.html"},
    {label:"My account", href:"/workspace/account.html", match:p=>p==="/workspace/account.html"},
    {label:"Plans", href:"/workspace/billing.html", match:p=>p==="/workspace/billing.html"},
    {label:"Sign in", href:"/workspace/login.html", match:p=>p==="/workspace/login.html"},
    {label:"Create account", href:"/workspace/signup.html", match:p=>p==="/workspace/signup.html"}
  ];
  if(document.querySelector(".kw-nav")) return;
  const nav=document.createElement("nav");
  nav.className="kw-nav";
  nav.setAttribute("aria-label","Main workspace navigation");
  const brand=document.createElement("a");
  brand.className="kw-nav-brand";
  brand.href="/workspace/";
  brand.innerHTML='<span>KENJI</span> AI WORKSPACE';
  const menu=document.createElement("div");
  menu.className="kw-nav-links";
  links.forEach(item=>{
    const a=document.createElement("a");
    a.href=item.href;
    a.textContent=item.label;
    if(item.match(path)){a.className="active";a.setAttribute("aria-current","page");}
    menu.appendChild(a);
  });
  nav.append(brand,menu);
  document.body.insertBefore(nav,document.body.firstChild);
})();
