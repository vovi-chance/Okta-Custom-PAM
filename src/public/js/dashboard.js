(() => {
  const form = document.getElementById('jit-form');
  if (!form) return;

  const requestType = document.getElementById('requestType');
  const durationInput = document.getElementById('durationMinutes');
  const durationHint = document.getElementById('duration-hint');
  const ticketGroup = document.getElementById('ticket-group');
  const submitBtn = document.getElementById('submit-btn');
  const alertSuccess = document.getElementById('alert-success');
  const alertError = document.getElementById('alert-error');

  let isSubmitting = false;

  const durationRanges = JSON.parse(form.dataset.durationRanges || '{}');

  requestType.addEventListener('change', function() {
    // Show/hide type info
    document.querySelectorAll('.type-info').forEach(el => el.classList.remove('show'));
    const info = document.getElementById('info-' + this.value);
    if (info) info.classList.add('show');

    // Show/hide ticket field
    ticketGroup.classList.toggle('show', this.value === 'emergency');

    // Update duration constraints
    const range = durationRanges[this.value];
    if (range) {
      durationInput.min = range.min;
      durationInput.max = range.max;
      durationHint.textContent = 'Range: ' + range.min + ' - ' + range.max + ' minutes';
    } else {
      durationHint.textContent = '';
    }
  });

  function showAlert(type, message) {
    const el = type === 'success' ? alertSuccess : alertError;
    const other = type === 'success' ? alertError : alertSuccess;
    el.textContent = message;
    el.style.display = 'block';
    other.style.display = 'none';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Submitting...';
    alertSuccess.style.display = 'none';
    alertError.style.display = 'none';

    const body = {
      requestType: requestType.value,
      durationMinutes: parseInt(durationInput.value, 10),
      businessJustification: document.getElementById('businessJustification').value,
    };

    if (requestType.value === 'emergency') {
      body.incidentTicket = document.getElementById('incidentTicket').value;
    }

    try {
      const res = await fetch('/api/jit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        showAlert('success', data.message + ' (Request ID: ' + data.requestId + ')');
        form.reset();
        document.querySelectorAll('.type-info').forEach(el => el.classList.remove('show'));
        ticketGroup.classList.remove('show');
        durationHint.textContent = '';
      } else {
        const msg = data.errors
          ? data.errors.join('. ')
          : data.error || 'Submission failed. Please try again.';
        showAlert('error', msg);
      }
    } catch (err) {
      showAlert('error', 'Network error. Please check your connection and try again.');
    } finally {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Submit Request';
    }
  });
})();
