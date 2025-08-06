// Hello World function
function helloWorld() {
    console.log("Hello, World!");
}

// Export for use in other modules
module.exports = { helloWorld };

// Run if called directly
if (require.main === module) {
    helloWorld();
}
