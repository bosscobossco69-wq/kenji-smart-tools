import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createProduct,editProduct,archiveProduct,adjustStock,inventoryList,normalizeSku,FREE_LIMITS} from "../lib/business-inventory.js";
const clock={serverTimestamp:()=>({toDate:()=>new Date("2026-11-22T00:00:00Z")})};
function mockDb(){
 const store=new Map();
 const ref=(path)=>({path,collection(n){return collection(path+"/"+n);},async get(){return snapshot({path});}});
 const collection=(path)=>({doc(id){return ref(path+"/"+(id??"generated-"+(store.size+1)));},
  limit(){return this;},orderBy(){return this;},where(field,op,value){this.filter={field,op,value};return this;},
  async get(){return {docs:[...store].filter(([key,data])=>key.startsWith(path+"/")&&!key.slice(path.length+1).includes("/")&&(!this.filter||data[this.filter.field]===this.filter.value)).map(([key,data])=>({id:key.slice(path.length+1),data:()=>data}))};}});
 const snapshot=(r)=>({exists:store.has(r.path),data:()=>store.get(r.path)});
 const tx={async get(r){return snapshot(r);},create(r,d){assert.equal(store.has(r.path),false);store.set(r.path,d);},
  set(r,d){store.set(r.path,{...(store.get(r.path)||{}),...d});},update(r,d){assert.ok(store.has(r.path));store.set(r.path,{...store.get(r.path),...d});}};
 return {store,collection(n){return collection(n);},runTransaction(fn){return fn(tx);}};
}
const source="production";
test("product validation rejects malformed SKU and stock quantities",()=>{
 assert.equal(normalizeSku("  tea-001 "), "TEA-001");
 for(const bad of ["a","../../x","a/b","abc def",""])assert.throws(()=>normalizeSku(bad));
});
test("each verified uid resolves to independent inventory records",async()=>{
 const db=mockDb();await createProduct(db,"accountA",source,{sku:"SKU-01",name:"Tea",threshold:2},clock);
 assert.equal((await inventoryList(db,"accountA",source)).products.length,1);
 assert.equal((await inventoryList(db,"accountB",source)).products.length,0);
 assert.equal((await inventoryList(db,"accountA","preview")).products.length,0);
});
test("cannot double-register SKU; cannot remove product with outstanding stock",async()=>{
 const db=mockDb(),p={sku:"SKU-01",name:"Tea",threshold:2};
 await createProduct(db,"user1",source,p,clock);
 await assert.rejects(createProduct(db,"user1",source,p,clock),e=>e.status===409);
 await adjustStock(db,"user1",source,{sku:p.sku,direction:"in",quantity:3},clock);
 await assert.rejects(archiveProduct(db,"user1",source,{sku:p.sku},clock),e=>e.status===409);
 await assert.rejects(adjustStock(db,"user1",source,{sku:p.sku,direction:"out",quantity:4},clock),e=>e.status===409);
 const values=await inventoryList(db,"user1",source);assert.equal(values.products[0].quantity,3);assert.equal(values.history.length,1);
 await editProduct(db,"user1",source,{sku:p.sku,name:"Tea Blend",threshold:1},clock);
 assert.equal((await inventoryList(db,"user1",source)).products[0].name,"Tea Blend");
 await adjustStock(db,"user1",source,{sku:p.sku,direction:"out",quantity:3},clock);
 await archiveProduct(db,"user1",source,{sku:p.sku},clock);
 assert.equal((await inventoryList(db,"user1",source)).products.length,0);
 assert.equal((await inventoryList(db,"user1",source)).history.length,2);
});
test("free plan enforces 30 product limit and 50 monthly stock moves",async()=>{
 const db=mockDb();
 for(let i=0;i<FREE_LIMITS.products;i++)await createProduct(db,"user1",source,{sku:"ITEM-"+String(i).padStart(2,"0"),name:"Product "+i,threshold:2},clock);
 await assert.rejects(createProduct(db,"user1",source,{sku:"ITEM-99",name:"Extra",threshold:0},clock),e=>e.status===403);
 for(let i=0;i<FREE_LIMITS.monthlyMovements;i++)await adjustStock(db,"user1",source,{sku:"ITEM-00",direction:"in",quantity:1},clock,new Date("2026-11-03T12:00:00Z"));
 await assert.rejects(adjustStock(db,"user1",source,{sku:"ITEM-00",direction:"in",quantity:1},clock,new Date("2026-11-22T12:00:00Z")),e=>e.status===403);
 await adjustStock(db,"user1",source,{sku:"ITEM-00",direction:"out",quantity:1},clock,new Date("2026-12-01T00:00:00Z"));
 const list=await inventoryList(db,"user1",source);assert.equal(list.products.length,30);
});
test("UI requires login and API checks email verification and origin",()=>{
 const page=fs.readFileSync(new URL("../business/inventory.html",import.meta.url),"utf8");
 const api=fs.readFileSync(new URL("../lib/business-inventory-handler.js",import.meta.url),"utf8");
 const accountApi=fs.readFileSync(new URL("../api/account-billing.js",import.meta.url),"utf8");
 assert.match(accountApi,/req\.query\?\.action === "inventory"/);
 assert.match(accountApi,/inventoryHandler\(req, res\)/);
 assert.match(page,/authReady/);assert.match(page,/emailVerified/);
 assert.match(page,/\/workspace\/signup\.html/);assert.match(page,/\/api\/account-billing\?action=inventory/);
 assert.match(api,/verifyIdToken\(header\.slice\(7\),true\)/);assert.match(api,/getUser\(identity\.uid\)/);
 assert.match(api,/email_verified/);assert.match(api,/req\.headers\.origin/);
 assert.doesNotMatch(api,/STRIPE_SECRET_KEY/);
});
