'use strict';

(function() {
  var form = document.getElementById('jit-form');
  var requestType = document.getElementById('requestType');
  var durationInput = document.getElementById('durationMinutes');
  var durationUnit = document.getElementById('durationUnit');
  var durationHint = document.getElementById('duration-hint');
  var submitBtn = document.getElementById('submit-btn');
  var alertSuccess = document.getElementById('alert-success');
  var alertError = document.getElementById('alert-error');
  var justificationGroup = document.getElementById('justification-group');
  var justificationInput = document.getElementById('businessJustification');

  // durationRanges is set on window by the inline data attribute
  var durationRanges = JSON.parse(
    document.getElementById('jit-form').getAttribute('data-duration-ranges')
  );

  function updateDurationConstraints() {
    var type = requestType.value;
    var range = durationRanges[type];
    if (!range) {
      durationHint.textContent = '';
      return;
    }

    var unit = durationUnit.value;
    if (unit === 'hours') {
      var minH = +(range.min / 60).toFixed(2);
      var maxH = +(range.max / 60).toFixed(2);
      durationInput.min = minH;
      durationInput.max = maxH;
      durationInput.step = '0.25';
      durationHint.textContent = 'Range: ' + minH + ' - ' + maxH + ' hours';
    } else {
      durationInput.min = range.min;
      durationInput.max = range.max;
      durationInput.step = '1';
      durationHint.textContent = 'Range: ' + range.min + ' - ' + range.max + ' minutes';
    }
  }

  requestType.addEventListener('change', function() {
    // Show/hide type info
    document.querySelectorAll('.type-info').forEach(function(el) {
      el.classList.remove('show');
    });
    var info = document.getElementById('info-' + this.value);
    if (info) info.classList.add('show');

    // Show/hide business justification (hidden for extended)
    if (this.value === 'extended') {
      justificationGroup.style.display = 'none';
      justificationInput.required = false;
    } else if (this.value) {
      justificationGroup.style.display = 'block';
      justificationInput.required = true;
    } else {
      justificationGroup.style.display = 'none';
      justificationInput.required = false;
    }

    updateDurationConstraints();
  });

  durationUnit.addEventListener('change', function() {
    // Convert current value when switching units
    var val = parseFloat(durationInput.value);
    if (!isNaN(val) && val > 0) {
      if (this.value === 'hours') {
        durationInput.value = +(val / 60).toFixed(2);
      } else {
        durationInput.value = Math.round(val * 60);
      }
    }
    updateDurationConstraints();
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

    // Convert to minutes if user selected hours
    var rawValue = parseFloat(durationInput.value);
    var durationMinutes = durationUnit.value === 'hours'
      ? Math.round(rawValue * 60)
      : parseInt(rawValue, 10);

    var body = {
      requestType: requestType.value,
      durationMinutes: durationMinutes,
    };

    // Include justification for standard and emergency only
    if (requestType.value !== 'extended') {
      body.businessJustification = justificationInput.value;
    }

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
          justificationGroup.style.display = 'none';
          justificationInput.required = false;
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
