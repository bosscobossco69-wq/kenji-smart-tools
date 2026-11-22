const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const root=path.join(__dirname,"..");
async function load(sourcePath,importNames){
  const module=new vm.SourceTextModule(fs.readFileSync(path.join(root,sourcePath),"utf8"),{identifier:sourcePath});
  await module.link(async specifier=>{
    const exports=(importNames[specifier]||{});
    return new vm.SyntheticModule(Object.keys(exports),function(){
      for(const [k,v] of Object.entries(exports))this.setExport(k,v);
    });
  });
  await module.evaluate();
  return module.namespace;
}
const timestamp={toMillis:()=>1000};
const owner={uid:"firebase-uid",email:"admin@example.com",emailVerified:true,disabled:false};
const approved={uid:owner.uid,email:owner.email,marketingConsent:true,consentedAt:timestamp};
test("purchase suppression includes Credits, subscriptions, invoices and website orders",async()=>{
 const {hasPurchasedFromRecords:check}=await load("lib/marketing-purchase.js",{"./billing-environment.js":{billingCollection:()=> "billing_live"}});
 const base={billing:{creditBalance:0,status:"inactive"},orders:[],websiteOrders:[],onboardingOrders:[],ledger:[]};
 assert.equal(check(base),false);
 for(const changed of [
  {billing:{status:"active"}},
  {billing:{lastCreditOrderId:"ord123"}},
  {billing:{creditBalance:100}},
  {billing:{stripeSubscriptionId:"sub123"}},
  {orders:[{status:"paid"}]},
  {orders:[{status:"checkout_completed"}]},
  {websiteOrders:[{status:"paid"}]},
  {onboardingOrders:[{status:"paid"}]},
  {ledger:[{type:"stripe_pack"}]}
 ])assert.equal(check({...base,...changed}),true,JSON.stringify(changed));
 assert.equal(check({...base,orders:Array.from({length:100},()=>({status:"pending"}))}),true);
});
test("administrator marketing test cannot target arbitrary or unverified customers",async()=>{
 const {eligibleForMarketingTest:check}=await load("lib/marketing-admin-test.js",{
  "firebase-admin/firestore.js":{FieldValue:{}},
  "./marketing-consent.js":{preferenceRef:()=>{},unsubscribeSignature:()=>""},
  "./marketing-purchase.js":{hasRecordedPurchase:async()=>false}
 });
 assert.equal(check(owner,approved,owner.email),"eligible");
 assert.equal(check(owner,undefined,owner.email),"consent_required");
 assert.equal(check(owner,{...approved,marketingConsent:false},owner.email),"consent_required");
 assert.equal(check(owner,{...approved,unsubscribedAt:timestamp},owner.email),"consent_required");
 assert.equal(check({...owner,emailVerified:false},approved,owner.email),"verified_admin_required");
 assert.equal(check(owner,approved,"another@example.com"),"verified_admin_required");
 assert.equal(check({...owner,disabled:true},approved,owner.email),"verified_admin_required");
});
test("production endpoint is admin-authenticated, same-origin, fixed-recipient and one-per-day",()=>{
 const api=fs.readFileSync(path.join(root,"api/website-orders-admin.js"),"utf8");
 const mail=fs.readFileSync(path.join(root,"lib/marketing-admin-test.js"),"utf8");
 const page=fs.readFileSync(path.join(root,"website-admin.html"),"utf8");
 assert.match(api,/verifyIdToken\(h\.slice\(7\),true\)/);
 assert.match(api,/currentUser\.emailVerified/);
 assert.match(api,/req\.headers\.origin!=="https:\/\/"\+req\.headers\.host/);
 assert.match(api,/Object\.keys\(req\.body\)\.length!==1/);
 assert.match(api,/person:currentUser,adminEmail:configuredEmail/);
 assert.match(mail,/person\.uid\+"_"\+dayUTC\(\)/);
 assert.match(mail,/if\(prior\.exists\)return/);
 assert.match(mail,/hasRecordedPurchase\(db,person\)/);
 assert.match(mail,/unsubscribe\.html\?uid=/);
 assert.match(mail,/to:\[person\.email\]/);
 assert.match(page,/Send one marketing test to my email/);
 assert.match(page,/marketing_test_email/);
 assert.doesNotMatch(mail,/MARKETING_EMAILS_ENABLED\s*=\s*"true"/);
});
