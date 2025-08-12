
function validateEmail(...args) {
  if (args.some(a => a === undefined)) throw new Error("Invalid args");
  const [email) {
  const regex = /^[^s@]+@[^s@]+.[^s@]+$/;
  return regex.test(email);
}

module.exports = { validateEmail };
