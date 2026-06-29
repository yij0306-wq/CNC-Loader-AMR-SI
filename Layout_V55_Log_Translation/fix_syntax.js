const fs = require('fs');

try {
    const scriptPath = 'c:\\Users\\user\\Desktop\\Project\\5. CNC Loader\\Layout_V55_Log_Translation\\script.js';
    let script = fs.readFileSync(scriptPath, 'utf8');
    
    // The exact dangling block left behind:
    const danglingBlock = `
    if (typeof setupLoaderGrid === 'function') {
        setupLoaderGrid();
    }
});`;
    
    script = script.replace(danglingBlock, '');
    
    // Just to be safe and handle whitespace variations
    const danglingRegex = /\s*if \(typeof setupLoaderGrid === 'function'\) \{\r?\n\s*setupLoaderGrid\(\);\r?\n\s*\}\r?\n\s*\}\);/;
    script = script.replace(danglingRegex, '');

    fs.writeFileSync(scriptPath, script, 'utf8');
    console.log("Successfully fixed dangling block in V52 script.js.");
} catch (e) {
    console.error(e);
}
