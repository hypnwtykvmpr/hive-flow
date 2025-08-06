// Hello World function
export function helloWorld() {
    console.log("Hello, World!");
}

// Run if called directly
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    helloWorld();
}
