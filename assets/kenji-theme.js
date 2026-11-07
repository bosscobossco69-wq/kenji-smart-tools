/* KENJI theme preference: saved locally on this browser, no account data required. */
(() => {
 const key="kenji-theme";
 const root=document.documentElement;
 const valid=value=>value==="light"||value==="dark";
 let theme="dark";
 try{
  const saved=localStorage.getItem(key);
  theme=valid(saved)?saved:((window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark");
 }catch{}
 const apply=value=>{
  theme=value;root.dataset.theme=value;
  const button=document.querySelector(".kenji-theme-toggle");
  if(button){
   const light=value==="light";
   button.textContent=light?"☾ Dark mode":"☀ Light mode";
   button.setAttribute("aria-label",light?"Switch to dark theme":"Switch to light theme");
   button.setAttribute("aria-pressed",String(light));
   button.title=light?"Switch to dark theme":"Switch to light theme";
  }
 };
 apply(theme);
 const mount=()=>{
  if(document.querySelector(".kenji-theme-toggle"))return;
  const button=document.createElement("button");
  button.type="button";button.className="kenji-theme-toggle";button.addEventListener("click",()=>{
   const next=theme==="dark"?"light":"dark";apply(next);
   try{localStorage.setItem(key,next)}catch{}
  });
  const nav=document.querySelector(".nav-inner");
  const navLinks=nav?.querySelector(".nav-links");
  const pageNav=document.querySelector("header.nav");
  if(nav&&navLinks){
   nav.insertBefore(button,navLinks.nextSibling);
  }else if(pageNav){
   const backLink=pageNav.querySelector("a:last-child");
   if(backLink) pageNav.insertBefore(button,backLink);
   else pageNav.appendChild(button);
  }else{
   document.body.appendChild(button);
  }
  apply(theme);
 };
 if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();
