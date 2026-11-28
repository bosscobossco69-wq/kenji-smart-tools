/* Lightweight, dependency-free motion for KENJI pages. */
(() => {
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;
  const selectors = [".hero", ".section-head", ".tool-card", ".more-tool-link", ".glass", ".principle", ".layout .card", ".plans > .card", ".packs > .card", ".grid > .card"];
  const nodes = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
  if (!nodes.length) return;
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("kenji-is-visible");
      currentObserver.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  document.documentElement.classList.add("kenji-motion-ready");
  nodes.forEach((node, index) => {
    node.classList.add("kenji-reveal");
    node.style.setProperty("--kenji-reveal-delay", Math.min(index % 5, 4) * 65 + "ms");
    observer.observe(node);
  });
})();

/* Free, local account-help widget. No AI call, identity lookup, storage or data collection. */
(() => {
  const path=location.pathname;
  const authPage=/^\/workspace\/(?:login|signup|forgot-password)(?:\.(?:ms|es|th|zh-CN|zh-TW))?\.html$/.test(path);
  if (!authPage && !["/","/index.html","/workspace/","/workspace/index.html","/workspace/account.html","/workspace/billing.html","/ai-customer-reply.html"].includes(path)) return;
  if(document.getElementById("kenji-help-entry"))return;
  const locale=path.match(/\.(ms|es|th|zh-CN|zh-TW)\.html$/)?.[1]||"en";
  const copy={
    en:["Help & support","KENJI Support","Free self-service help — no sign-in needed.","Forgot password","Use the password reset page. Check your inbox and spam folder; never share your password or verification code.","Google sign-in","Use a normal browser and select your correct Google account. If sign-in fails, contact support; never share your Google password.","Email verification","Check your inbox and spam folder for the verification link. If you can sign in, check your verification status in My Account.","Payments & Credits","Open Plans & Credits to review your purchase and manage subscriptions. If Credits are missing, contact support with your receipt reference only. Never send card details.","Reset password","Sign in","My Account","Plans & Credits","Contact support by email","Close"],
    "zh-CN":["帮助与客服","KENJI 专属客服","免费自助帮助，无需登录。","忘记密码","打开重置密码页面，检查收件箱及垃圾邮件。请勿分享密码或验证码。","Google 登录失败","使用普通浏览器并选择正确的 Google 账户。如仍失败，请联系客服，勿提供 Google 密码。","邮箱验证","检查邮箱和垃圾邮件中的验证链接。登录后可在个人账户查看验证状态。","付款与 Credits","前往套餐与 Credits 查看购买及管理订阅。如未到账，请联系客服，仅提供收据编号，不要发送银行卡资料。","重置密码","登录","个人账户","套餐与 Credits","邮件联系人工客服","关闭"],
    "zh-TW":["幫助與客服","KENJI 專屬客服","免費自助幫助，無需登入。","忘記密碼","開啟重設密碼頁面，檢查收件匣及垃圾郵件。請勿分享密碼或驗證碼。","Google 登入失敗","使用一般瀏覽器並選擇正確的 Google 帳戶。如仍失敗，請聯絡客服，勿提供 Google 密碼。","電子郵件驗證","檢查收件匣及垃圾郵件中的驗證連結。登入後可在個人帳戶查看驗證狀態。","付款與 Credits","前往方案與 Credits 查看購買及管理訂閱。如未入帳，請聯絡客服，僅提供收據編號，勿傳送信用卡資料。","重設密碼","登入","個人帳戶","方案與 Credits","電子郵件聯絡客服","關閉"],
    th:["ความช่วยเหลือ","ฝ่ายช่วยเหลือ KENJI","ช่วยเหลือตนเองฟรี ไม่ต้องเข้าสู่ระบบ","ลืมรหัสผ่าน","เปิดหน้ารีเซ็ตรหัสผ่าน ตรวจสอบกล่องจดหมายและสแปม ห้ามส่งรหัสผ่านหรือรหัสยืนยัน","เข้าสู่ระบบ Google ไม่ได้","ใช้เบราว์เซอร์ปกติและเลือกบัญชี Google ที่ถูกต้อง หากยังไม่ได้ให้ติดต่อฝ่ายช่วยเหลือ ห้ามส่งรหัสผ่าน","ยืนยันอีเมล","ตรวจสอบลิงก์ยืนยันในกล่องจดหมายและสแปม เมื่อเข้าสู่ระบบแล้วตรวจสอบสถานะในบัญชีของฉัน","การชำระเงินและ Credits","เปิดหน้าแพ็กเกจและ Credits เพื่อจัดการการสมัครสมาชิก หาก Credits ไม่เข้า ให้ติดต่อฝ่ายช่วยเหลือพร้อมเลขอ้างอิงใบเสร็จเท่านั้น ห้ามส่งข้อมูลบัตร","รีเซ็ตรหัสผ่าน","เข้าสู่ระบบ","บัญชีของฉัน","แพ็กเกจและ Credits","ติดต่อทางอีเมล","ปิด"],
    es:["Ayuda y soporte","Soporte KENJI","Ayuda gratuita sin iniciar sesión.","Olvidé mi contraseña","Abre la página de restablecimiento. Revisa tu correo y spam. No compartas contraseñas ni códigos.","Problemas con Google","Usa un navegador normal y elige tu cuenta de Google correcta. Si falla, contacta con soporte; nunca compartas tu contraseña.","Verificar correo","Busca el enlace de verificación en tu correo y spam. Si puedes entrar, revisa el estado en Mi cuenta.","Pagos y Credits","Abre Planes y Credits para revisar compras y gestionar suscripciones. Si faltan Credits, contacta con soporte indicando solo la referencia del recibo, nunca los datos de la tarjeta.","Restablecer contraseña","Iniciar sesión","Mi cuenta","Planes y Credits","Contactar por correo","Cerrar"],
    ms:["Bantuan dan sokongan","Sokongan KENJI","Bantuan layan diri percuma tanpa log masuk.","Lupa kata laluan","Buka halaman tetapan semula kata laluan. Semak peti masuk dan spam. Jangan kongsi kata laluan atau kod pengesahan.","Masalah log masuk Google","Gunakan pelayar biasa dan pilih akaun Google yang betul. Jika gagal, hubungi sokongan; jangan kongsi kata laluan.","Pengesahan e-mel","Semak pautan pengesahan dalam peti masuk dan spam. Selepas log masuk, semak status di Akaun Saya.","Bayaran dan Credits","Buka Pelan dan Credits untuk menyemak pembelian dan langganan. Jika Credits belum diterima, hubungi sokongan dengan nombor rujukan resit sahaja. Jangan hantar butiran kad.","Tetapkan semula kata laluan","Log masuk","Akaun Saya","Pelan dan Credits","Hubungi melalui e-mel","Tutup"]
  }[locale];
  const suffix=locale==="en"?"":"."+locale;
  const el=(tag,value)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;return node;};
  const entry=el("button","?  "+copy[0]);entry.id="kenji-help-entry";entry.type="button";entry.setAttribute("aria-haspopup","dialog");entry.setAttribute("aria-controls","kenji-help-dialog");
  const dialog=el("dialog");dialog.id="kenji-help-dialog";dialog.setAttribute("aria-labelledby","kenji-help-title");dialog.lang=document.documentElement.lang||locale;
  const title=el("h2",copy[1]);title.id="kenji-help-title";dialog.append(title,el("p",copy[2]));
  const actions=[["/workspace/forgot-password"+suffix+".html",copy[11]],["/workspace/login"+suffix+".html",copy[12]],["/workspace/account.html",copy[13]],["/workspace/billing.html",copy[14]]];
  for(let i=0;i<4;i++){
    const details=el("details");details.append(el("summary",copy[3+i*2]),el("p",copy[4+i*2]));
    const a=el("a",actions[i][1]);a.href=actions[i][0];details.append(a);dialog.append(details);
  }
  const email=el("a",copy[15]);email.href="mailto:kenjing3073@gmail.com?subject=KENJI%20account%20support";email.className="kenji-help-email";dialog.append(email);
  const close=el("button",copy[16]);close.type="button";close.className="kenji-help-close";dialog.append(close);
  const mount=authPage?document.querySelector("main.wrap .panel"):null;
  (mount||document.body).append(entry);document.body.append(dialog);
  if(!mount)entry.classList.add("kenji-help-floating");
  entry.addEventListener("click",()=>{if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");});
  close.addEventListener("click",()=>{if(typeof dialog.close==="function")dialog.close();else{dialog.removeAttribute("open");entry.focus();}});
  dialog.addEventListener("close",()=>entry.focus());
})();

/* Independent, free KENJI support. No chat content is saved locally. */
(() => {
 const dialog=document.getElementById("kenji-help-dialog"); if(!dialog)return;
 const lang=dialog.lang||"en";
 const words={
 en:["AI support","Ask a KENJI question","Send","My Credits & orders","Human support ticket","Contact email (for guests)","Describe the issue","Submit ticket","I agree: AI questions go to an external AI provider; tickets are saved for human support. Do not enter passwords, codes, card numbers or other sensitive data.","Request failed. Use the help links or email support.","Ticket reference","Available Credits","Subscription","Orders (sample)","Working…","No orders found","Sign in and verify email to view your own account.","Guest emails are not verified. Staff must confirm identity before account changes."],
 "zh-CN":["AI 专属客服","请输入 KENJI 使用问题","发送","我的 Credits 与订单","人工客服工单","联系邮箱（访客）","描述遇到的问题","提交工单","我同意：AI 问题会发送给外部 AI 服务商；工单会保存供人工客服处理。请勿输入密码、验证码、银行卡号或敏感资料。","请求失败，请使用自助帮助或邮件客服。","工单编号","可用 Credits","订阅","订单（抽样）","处理中…","暂无订单","请登录并验证邮箱后查询自己的账户。","访客邮箱未验证，账户变更须由人工核实身份。"],
 "zh-TW":["AI 專屬客服","請輸入 KENJI 使用問題","傳送","我的 Credits 與訂單","人工客服工單","聯絡信箱（訪客）","描述遇到的問題","提交工單","我同意：AI 問題會傳送給外部 AI 服務商；工單會保存供人工客服處理。請勿輸入密碼、驗證碼、信用卡號或敏感資料。","請求失敗，請使用自助幫助或電子郵件客服。","工單編號","可用 Credits","訂閱","訂單（抽樣）","處理中…","暫無訂單","請登入並驗證電子郵件後查詢自己的帳戶。","訪客信箱未驗證，帳戶變更須由人工核實身分。"],
 th:["AI ช่วยเหลือ","ถามเกี่ยวกับ KENJI","ส่ง","Credits และคำสั่งซื้อของฉัน","ส่งเรื่องให้เจ้าหน้าที่","อีเมลติดต่อ (ผู้เยี่ยมชม)","อธิบายปัญหา","ส่งเรื่อง","ฉันยอมรับว่าคำถามจะส่งไปยังผู้ให้บริการ AI ภายนอก และเรื่องร้องขอจะเก็บไว้ให้เจ้าหน้าที่ ห้ามกรอกรหัสผ่าน รหัสยืนยัน หรือข้อมูลบัตร","คำขอล้มเหลว โปรดใช้เมนูช่วยเหลือหรืออีเมล","หมายเลขเรื่อง","Credits ที่ใช้ได้","การสมัครสมาชิก","คำสั่งซื้อ (ตัวอย่าง)","กำลังดำเนินการ…","ไม่พบคำสั่งซื้อ","เข้าสู่ระบบและยืนยันอีเมลก่อนดูบัญชี","อีเมลผู้เยี่ยมชมยังไม่ผ่านการยืนยัน"],
 es:["Asistente IA","Pregunta sobre KENJI","Enviar","Mis Credits y pedidos","Solicitud de soporte humano","Correo de contacto (invitados)","Describe el problema","Enviar solicitud","Acepto: las preguntas se envían a un proveedor de IA externo y las solicitudes se guardan para soporte humano. No incluyas contraseñas, códigos ni datos de tarjetas.","Error. Usa la ayuda o contacta por correo.","Referencia de solicitud","Credits disponibles","Suscripción","Pedidos (muestra)","Procesando…","No hay pedidos","Inicia sesión y verifica tu correo para consultar tu cuenta.","El correo de invitado no está verificado."],
 ms:["Pembantu AI","Tanya tentang KENJI","Hantar","Credits dan pesanan saya","Tiket sokongan manusia","E-mel hubungan (tetamu)","Terangkan masalah","Hantar tiket","Saya bersetuju: soalan dihantar kepada penyedia AI luar dan tiket disimpan untuk sokongan manusia. Jangan masukkan kata laluan, kod atau butiran kad.","Permintaan gagal. Guna bantuan atau e-mel.","Rujukan tiket","Credits tersedia","Langganan","Pesanan (sampel)","Sedang diproses…","Tiada pesanan","Log masuk dan sahkan e-mel untuk menyemak akaun sendiri.","E-mel tetamu belum disahkan."]
 }[lang]||null;
 const locale=words?lang:"en";const t=words||["AI support","Ask a KENJI question","Send","My Credits & orders","Human support ticket","Contact email (for guests)","Describe the issue","Submit ticket","I agree: AI questions go to an external AI provider; tickets are saved for human support. Do not enter passwords, codes or card numbers.","Request failed. Use the help links or email support.","Ticket reference","Available Credits","Subscription","Orders (sample)","Working…","No orders found","Sign in and verify email to view your own account.","Guest emails are not verified."];
 const e=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const button=label=>{const b=e("button",label);b.type="button";return b;};
 const consent=e("input");consent.type="checkbox";consent.id="kenji-support-consent";
 const label=e("label",t[8]);label.prepend(consent);
 const section=e("section");section.className="kenji-support-live";section.append(e("h3",t[0]),label);
 const ask=e("textarea");ask.placeholder=t[1];ask.setAttribute("aria-label",t[1]);ask.maxLength=800;ask.rows=2;
 const send=button(t[2]),account=button(t[3]);const controls=e("div");controls.className="kenji-support-actions";controls.append(send,account);const log=e("div");log.className="kenji-support-log";log.setAttribute("role","status");log.setAttribute("aria-live","polite");
 const ticket=e("details");ticket.append(e("summary",t[4]),e("p",t[17]));const contact=e("input");contact.type="email";contact.placeholder=t[5];contact.setAttribute("aria-label",t[5]);contact.maxLength=254;
 const description=e("textarea");description.placeholder=t[6];description.setAttribute("aria-label",t[6]);description.maxLength=1200;description.rows=3;const submit=button(t[7]);ticket.append(contact,description,submit);
 const shortcuts=e("div");shortcuts.className="kenji-support-shortcuts";const suffix=locale==="en"?"":"."+locale;for(const [href,label] of [["/workspace/forgot-password"+suffix+".html",dialog.querySelector("details a")?.textContent||"Reset password"],["/workspace/login"+suffix+".html",dialog.querySelectorAll("details a")[1]?.textContent||"Sign in"],["/workspace/billing.html",dialog.querySelectorAll("details a")[3]?.textContent||"Plans & Credits"]]){const a=e("a",label);a.href=href;shortcuts.append(a);}section.append(ask,controls,log,shortcuts,ticket);dialog.insertBefore(section,dialog.querySelector("details"));
 let busy=false, generation=0, history=[], trackedUid=null;
 let privateAuth=null;
 async function currentAuth(){
   // Public chat/tickets never require Firebase import or a token.
   const f=await import("/workspace/firebase-auth.js");await f.authReady;
   if(typeof f.auth.authStateReady==="function")await f.auth.authStateReady();
   if(!privateAuth){privateAuth=f.auth;trackedUid=f.auth.currentUser?.uid||null;f.onAuthStateChanged(f.auth,u=>{const uid=u?.uid||null;if(uid!==trackedUid){trackedUid=uid;generation++;log.textContent="";history=[];description.value="";contact.value="";ask.value="";}});}
   return f.auth.currentUser;
 }
 async function request(body,authRequired=false){
   const headers={"Content-Type":"application/json"};
   let requestedUid=null;
   if(authRequired){const u=await currentAuth();if(!u?.emailVerified)throw Error(t[16]);requestedUid=u.uid;headers.Authorization="Bearer "+await u.getIdToken(true);if(privateAuth?.currentUser?.uid!==requestedUid)throw Error(t[16]);}
   const r=await fetch("/api/kenji-support",{method:"POST",headers,body:JSON.stringify(body),cache:"no-store"});
   const data=await r.json().catch(()=>({}));if(authRequired&&privateAuth?.currentUser?.uid!==requestedUid)throw Error(t[16]);if(!r.ok)throw Error(t[9]+(locale==="en"&&data.error?" "+data.error:""));return data;
 }
 async function run(task){if(busy)return;const start=generation;busy=true;for(const b of [send,account,submit])b.disabled=true;log.textContent=t[14];try{await task();}catch(err){if(start===generation&&dialog.open)log.textContent=err.message||t[9];}finally{busy=false;for(const b of [send,account,submit])b.disabled=false;}}
 send.addEventListener("click",()=>run(async()=>{if(!consent.checked||!ask.value.trim())throw Error(t[8]);const question=ask.value;const v=generation;let signed=false;if(!/^\/workspace\/(login|signup|forgot-password)/.test(location.pathname)){try{signed=Boolean((await currentAuth())?.emailVerified);}catch{}}if(v!==generation||!dialog.open)return;const d=await request({action:"chat",locale,message:question,history,consent:true},signed);if(v!==generation||!dialog.open)return;history=[...history,question].slice(-2);log.textContent=String(d.reply||"").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/`([^`]+)`/g,"$1");ask.value="";}));
 account.addEventListener("click",()=>run(async()=>{const v=generation;const d=await request({action:"account"},true);if(v!==generation||!dialog.open)return;log.textContent=t[11]+": "+d.balance+(d.debt?" · Debt: "+d.debt:"")+"\n"+t[12]+": "+d.subscription+"\n"+t[13]+" · "+d.environment+"\n"+(d.orders.length?d.orders.map(o=>[o.id,o.type,o.status,o.amount===null?"":(o.amount/100).toFixed(2)+" "+(o.currency||""),o.createdAt?.slice(0,10)||""].join(" · ")).join("\n"):t[15]);}));
 submit.addEventListener("click",()=>run(async()=>{if(!consent.checked||!description.value.trim())throw Error(t[8]);let signed=false;try{const u=await currentAuth();signed=Boolean(u?.emailVerified);}catch{}if(!signed&&!contact.validity.valid||!signed&&!contact.value.trim())throw Error(t[5]);const v=generation;const d=await request({action:"ticket",message:description.value,contact:signed?"":contact.value,consent:true},signed);if(v!==generation||!dialog.open)return;log.textContent=t[10]+": "+d.id;description.value="";contact.value="";ticket.open=false;}));
 dialog.addEventListener("close",()=>{generation++;history=[];log.textContent="";ask.value="";description.value="";contact.value="";consent.checked=false;});
})();

/* Match the visible brand label on all localized auth pages. */
for(const brand of document.querySelectorAll('a.brand[aria-label="KENJI Smart Tools"]')){if(brand.querySelector(".brand-mark")?.textContent.trim()==="K"&&brand.querySelector(".brand-name"))brand.setAttribute("aria-label","K KENJI Smart Tools");}
