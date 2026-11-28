// Static HTML deployment: no framework, npm dependency or external build download.
import { readFileSync, writeFileSync } from "node:fs";
const pages=["index.html","age-calculator.html","tip-calculator.html","percentage-calculator.html","word-counter.html","json-formatter.html","password-generator.html","unit-converter.html","case-converter.html","website-services.html","privacy.html","terms.html"];
let config={};
try { config=JSON.parse(process.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG||"{}").speedInsights||{}; } catch {}
// Vercel supports its original route as well as a per-deployment v2 route.
// Only use a relative, same-origin JS path, never serialize the full environment.
const candidate=typeof config.scriptSrc==="string"?config.scriptSrc:"";
const safe=/^\/[A-Za-z0-9_/-]+\/script\.js$/.test(candidate)&&!candidate.startsWith("//");
const src=safe?candidate:"/_vercel/speed-insights/script.js";
const marker="<!-- KENJI_SPEED_INSIGHTS -->";
const snippet=marker+"\n<script>\n(function(){\n  if(location.search||location.hash)return;\n  window.si=window.si||function(){(window.siq=window.siq||[]).push(arguments);};\n  var s=document.createElement('script');s.defer=true;s.src="+JSON.stringify(src)+";document.head.appendChild(s);\n})();\n</script>\n";
for(const path of pages){
 let html=readFileSync(path,"utf8");
 if(html.includes(marker))continue;
 if(!/<\/head>/i.test(html))throw Error("Missing head in "+path);
 html=html.replace(/<\/head>/i,snippet+"</head>");
 writeFileSync(path,html,"utf8");
}
console.log("Speed Insights loader prepared for "+pages.length+" public pages; "+(safe?"deployment-provided route":"standard legacy route"));
