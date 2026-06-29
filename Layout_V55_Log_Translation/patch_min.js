const fs = require('fs');

try {
    const basePath = 'c:\\Users\\user\\Desktop\\Project\\5. CNC Loader\\Layout_V52_Multi_Language';
    
    // 1. Update index.html
    let htmlPath = basePath + '\\index.html';
    let html = fs.readFileSync(htmlPath, 'utf8');
    const btnRegex = /\s*<button id="btn-apply-min-all".*?<\/button>/;
    html = html.replace(btnRegex, '');
    fs.writeFileSync(htmlPath, html, 'utf8');

    // 2. Update script.js
    let scriptPath = basePath + '\\script.js';
    let script = fs.readFileSync(scriptPath, 'utf8');
    const listenerRegex = /document\.getElementById\('btn-apply-min-all'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);/;
    script = script.replace(listenerRegex, '');
    fs.writeFileSync(scriptPath, script, 'utf8');

    console.log("Successfully removed 'btn-apply-min-all' from index.html and script.js in V52.");
} catch (e) {
    console.error(e);
}
