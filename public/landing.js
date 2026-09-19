const demoDialog = document.getElementById('demo-dialog');
document.getElementById('show-demo').addEventListener('click', () => demoDialog.showModal());
document.getElementById('close-demo').addEventListener('click', () => demoDialog.close());
demoDialog.addEventListener('click', event => {
  if (event.target !== demoDialog) return;
  const rect = demoDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) demoDialog.close();
});
