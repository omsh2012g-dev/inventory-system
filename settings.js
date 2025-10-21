document.addEventListener('DOMContentLoaded', function () {
    const passwordForm = document.getElementById('password-form');

    function showNotification(message, type = 'success') {
        Toastify({
            text: message,
            duration: 3000,
            close: true,
            gravity: "top",
            position: "left",
            stopOnFocus: true,
            style: {
                background: type === 'success' ? "linear-gradient(to right, #00b09b, #96c93d)" : "linear-gradient(to right, #ff5f6d, #ffc371)",
            },
        }).showToast();
    }

    passwordForm.addEventListener('submit', async function (event) {
        event.preventDefault();

        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (newPassword !== confirmPassword) {
            showNotification('New passwords do not match. Please try again.', 'error');
            return;
        }

        if (!newPassword) {
            showNotification('New password cannot be empty.', 'error');
            return;
        }

        try {
            const response = await fetch('/api/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ currentPassword, newPassword }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.message || 'An unknown error occurred.');
            }

            showNotification(result.message, 'success');
            passwordForm.reset();

        } catch (error) {
            showNotification(`Error: ${error.message}`, 'error');
        }
    });
});

