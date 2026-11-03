document.getElementById('add').addEventListener('click', () => {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = 'A new note';
  document.querySelector('main').insertBefore(p, document.getElementById('add'));
});
