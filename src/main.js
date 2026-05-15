import { loadSBootCore } from '@sboot/core';

function loadClassicScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.body.appendChild(script);
    });
}

async function bootstrap() {
    await loadSBootCore();
    await loadClassicScript('/js/app.js');
}

bootstrap().catch((error) => {
    console.error(error);
    const container = document.getElementById('log-container');
    if (container) {
        const entry = document.createElement('div');
        entry.className = 'log-entry error';
        entry.textContent = `Failed to start PyOdin Web: ${error.message}`;
        container.appendChild(entry);
    }
});
