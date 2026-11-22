const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const html=fs.readFileSync(path.join(__dirname,"..","customer-dashboard.html"),"utf8");
const js=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

test("dashboard module parses as JavaScript and keeps Firebase authentication",()=>{
 assert.ok(js,"inline dashboard module must exist");
 assert.doesNotThrow(()=>execFileSync(process.execPath,["--input-type=module","--check"],{input:js,stdio:["pipe","pipe","pipe"]}));
 assert.match(js,/verify|emailVerified/);
 assert.match(js,/getIdToken\(true\)/);
 assert.match(js,/customer_overview/);
});
test("navigation, search and sampled CSV export are present",()=>{
 for(const id of ["overview","traffic","signup","orders","activity","customers"])
   assert.ok(html.includes('id="'+id+'"'),"missing section "+id);
 assert.match(html,/id="orderSearch"/);
 assert.match(html,/id="customerSearch"/);
 assert.match(html,/id="exportOrders" disabled/);
 assert.match(js,/function filteredOrders\(/);
 assert.match(js,/data\.orders\.filter/);
 assert.match(js,/data\.users\.filter/);
 assert.match(js,/function csvValue\(/);
 assert.match(js,/\[=\+@-\]/);
 assert.match(js,/text\.replaceAll\('"','""'\)/);
 assert.match(js,/if\(!user\?\.emailVerified\|\|!data\)return/);
 assert.match(html,/sampled, not a complete accounting ledger/);
});
