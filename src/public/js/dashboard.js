'use strict';

(function() {
  var form = document.getElementById('jit-form');
  var requestType = document.getElementById('requestType');
  var durationInput = document.getElementById('durationMinutes');
  var durationHint = document.getElementById('duration-hint');
  var submitBtn = document.getElementById('submit-btn');
  var alertSuccess = document.getElementById('alert-success');
  var alertError = document.getElementById('alert-error');

  // durationRanges is set on window by the inline data attribute
  var durationRanges = JSON.parse(
    document.getElementById('jit-form').getAttribute('data-duration-ranges')
  );

  requestType.addEventListener('change', function() {
    // Show/hide type info
    document.querySelectorAll('.type-info').forEach(function(el) {
      el.classList.remove('show');
    });
    var info = document.getElementById('info-' + this.value);
    if (info) info.classList.add('show');

    // Update duration constraints
    var range = durationRanges[this.value];
    if (range) {
      durationInput.min = range.min;
      durationInput.max = range.max;
      durationHint.textContent = 'Range: ' + range.min + ' - ' + range.max + ' minutes';
    } else {
      durationHint.textContent = '';
    }
  });

  function showAlert(type, message) {
    var el = type === 'success' ? alertSuccess : alertError;
    var other = type === 'success' ? alertError : alertSuccess;
    el.textContent = message;
    el.style.display = 'block';
    other.style.display = 'none';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Submitting...';
    alertSuccess.style.display = 'none';
    alertError.style.display = 'none';

    var body = {
      requestType: requestType.value,
      durationMinutes: parseInt(durationInput.value, 10),
      businessJustification: document.getElementById('businessJustification').value,
    };

    fetch('/api/jit-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function(res) {
        return res.json().then(function(data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function(result) {
        if (result.ok && result.data.success) {
          showAlert('success', result.data.message + ' (Request ID: ' + result.data.requestId + ')');
          form.reset();
          document.querySelectorAll('.type-info').forEach(function(el) {
            el.classList.remove('show');
          });
          durationHint.textContent = '';
        } else {
          var msg = result.data.errors
            ? result.data.errors.join('. ')
            : result.data.error || 'Submission failed. Please try again.';
          showAlert('error', msg);
        }
      })
      .catch(function() {
        showAlert('error', 'Network error. Please check your connection and try again.');
      })
      .finally(function() {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Submit Request';
      });
  });
})();
