
export const FREE_LIMITS=Object.freeze({products:30,monthlyMovements:50});
export function serviceError(code,status,message){return Object.assign(new Error(message),{code,status});}
export function normalizeSku(v){
 if(typeof v!=="string")throw serviceError("invalid_sku",400,"SKU is required.");
 const s=v.trim().toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(s))throw serviceError("invalid_sku",400,"SKU must contain 2–32 letters, digits, dashes or underscores.");
 return s;
}
export function productInput(body){
 const name=body?.name,threshold=body?.threshold;
 if(typeof name!=="string"||!name.trim()||name.length>100)throw serviceError("invalid_name",400,"Enter a product name (up to 100 characters).");
 if(!Number.isSafeInteger(threshold)||threshold<0||threshold>1000000)throw serviceError("invalid_threshold",400,"Low stock threshold must be a whole number from 0 to 1,000,000.");
 return {name:name.trim(),threshold};
}
export function amountInput(body){
 const qty=body?.quantity;
 if(!Number.isSafeInteger(qty)||qty<1||qty>100000)throw serviceError("invalid_quantity",400,"Quantity must be a whole number from 1 to 100,000.");
 if(!["in","out"].includes(body?.direction))throw serviceError("invalid_direction",400,"Choose stock in or stock out.");
 return qty;
}
export function currentMonth(now=new Date()){return now.toISOString().slice(0,7);}
export function safeProduct(sku,d){
 return {sku,name:d.name,quantity:d.quantity,threshold:d.threshold,archived:d.archived===true,createdAt:d.createdAt?.toDate?.()?.toISOString?.()||null};
}
export function inventoryRefs(db,uid,environment){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(uid))throw serviceError("invalid_user",403,"Invalid account.");
 const space=environment==="production"?"live":"test";
 const account=db.collection("inventory_"+space+"_accounts").doc(uid);
 return {account,products:account.collection("products"),movements:account.collection("movements"),space};
}
export async function inventoryList(db,uid,environment){
 const {account,products,movements,space}=inventoryRefs(db,uid,environment);
 const [a,p,m]=await Promise.all([account.get(),products.limit(80).get(),movements.orderBy("createdAt","desc").limit(50).get()]);
 const month=currentMonth();const state=a.data()||{};
 const items=p.docs.map(d=>safeProduct(d.id,d.data())).filter(d=>!d.archived).sort((a,b)=>a.name.localeCompare(b.name));
 const history=m.docs.map(d=>{const x=d.data();return {sku:x.sku,direction:x.direction,quantity:x.quantity,balance:x.balance,createdAt:x.createdAt?.toDate?.()?.toISOString?.()||null};});
 return {plan:"free",environment:space,limits:FREE_LIMITS,products:items,
  monthlyMovements:state.month===month?(state.monthlyMovements||0):0,
  history};
}
export async function createProduct(db,uid,environment,body,FieldValue){
 const sku=normalizeSku(body?.sku),info=productInput(body);
 const {account,products}=inventoryRefs(db,uid,environment),ref=products.doc(sku);
 return db.runTransaction(async tx=>{
  const [a,p]=await Promise.all([tx.get(account),tx.get(ref)]);
  if(p.exists)throw serviceError("sku_exists",409,"This SKU is already registered, including archived products.");
  const count=a.data()?.activeProducts||0;
  if(count>=FREE_LIMITS.products)throw serviceError("limit_reached",403,"Free plan supports up to 30 active products.");
  tx.create(ref,{...info,quantity:0,archived:false,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
  tx.set(account,{activeProducts:count+1,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {sku,quantity:0};
 });
}
export async function editProduct(db,uid,environment,body,FieldValue){
 const sku=normalizeSku(body?.sku),info=productInput(body);
 const {products}=inventoryRefs(db,uid,environment),ref=products.doc(sku);
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref);
  if(!snap.exists||snap.data()?.archived)throw serviceError("not_found",404,"Active product not found.");
  tx.update(ref,{...info,updatedAt:FieldValue.serverTimestamp()});
  return {sku,updated:true};
 });
}
export async function archiveProduct(db,uid,environment,body,FieldValue){
 const sku=normalizeSku(body?.sku);
 const {account,products}=inventoryRefs(db,uid,environment),ref=products.doc(sku);
 return db.runTransaction(async tx=>{
  const [a,p]=await Promise.all([tx.get(account),tx.get(ref)]);
  if(!p.exists||p.data()?.archived)throw serviceError("not_found",404,"Active product not found.");
  if(p.data()?.quantity!==0)throw serviceError("stock_remaining",409,"Stock must be zero before archiving. Adjust stock out first.");
  tx.update(ref,{archived:true,updatedAt:FieldValue.serverTimestamp()});
  tx.set(account,{activeProducts:Math.max(0,(a.data()?.activeProducts||0)-1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {sku,archived:true};
 });
}
export async function adjustStock(db,uid,environment,body,FieldValue,now=new Date()){
 const sku=normalizeSku(body?.sku),qty=amountInput(body),direction=body.direction,month=currentMonth(now);
 const {account,products,movements}=inventoryRefs(db,uid,environment),ref=products.doc(sku),entry=movements.doc();
 return db.runTransaction(async tx=>{
  const [a,p]=await Promise.all([tx.get(account),tx.get(ref)]);
  if(!p.exists||p.data()?.archived)throw serviceError("not_found",404,"Active product not found.");
  const count=a.data()?.month===month?(a.data()?.monthlyMovements||0):0;
  if(count>=FREE_LIMITS.monthlyMovements)throw serviceError("movement_limit",403,"Free plan's 50 stock movements for this UTC month have been used.");
  const old=p.data()?.quantity;
  if(!Number.isSafeInteger(old)||old<0)throw serviceError("invalid_stock",409,"Stock record requires review.");
  const next=old+(direction==="in"?qty:-qty);
  if(!Number.isSafeInteger(next)||next<0||next>100000000)throw serviceError("invalid_stock",409,"Insufficient stock or stock quantity limit exceeded.");
  tx.update(ref,{quantity:next,updatedAt:FieldValue.serverTimestamp()});
  tx.create(entry,{sku,direction,quantity:qty,balance:next,createdAt:FieldValue.serverTimestamp()});
  tx.set(account,{month,monthlyMovements:count+1,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return {sku,quantity:next,monthlyMovements:count+1};
 });
}
