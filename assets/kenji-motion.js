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
  if (!authPage && !["/workspace/","/workspace/index.html","/workspace/account.html","/workspace/billing.html","/ai-customer-reply.html"].includes(path)) return;
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
