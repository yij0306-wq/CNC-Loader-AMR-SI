const fs = require('fs');

try {
    const scriptPath = 'c:\\Users\\user\\Desktop\\Project\\5. CNC Loader\\Layout_V52_Multi_Language\\script.js';
    let script = fs.readFileSync(scriptPath, 'utf8');
    
    // Remove the HTML generation
    const htmlRegex = /<button id="btn-apply-min-all" class="btn btn-reset-large" style="background:#ec4899; color:white; border:none; border-radius:6px; font-size:13px; padding:8px 15px; cursor:pointer; font-weight:bold; box-shadow:0 2px 4px rgba\(0,0,0,0\.2\);" data-i18n="btn_apply_min">\$\{t\('btn_apply_min'\)\}<\/button>\r?\n/;
    script = script.replace(htmlRegex, '');
    
    // Remove the event binding variable (if it still exists)
    const varRegex = /const btnApplyMin = document\.getElementById\('btn-apply-min-all'\);\r?\n/;
    script = script.replace(varRegex, '');
    
    // Remove any event listener if it still exists (it shouldn't, but just in case)
    const listenerRegex = /if\(btnApplyMin\) btnApplyMin\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);\r?\n/;
    script = script.replace(listenerRegex, '');

    fs.writeFileSync(scriptPath, script, 'utf8');
    console.log("Successfully removed dynamic button generation from script.js.");
} catch (e) {
    console.error(e);
}
