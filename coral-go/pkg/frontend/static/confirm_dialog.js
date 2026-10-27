/* Moved out of render.js as it was (#3795): no behaviour change. */

// Called when the open confirm modal is dismissed without confirming.
let _confirmCancel = null;

/** opts.label: the confirming button's word when "Yes" would not name the action ("Delete"); every other call keeps Yes. opts.danger: true makes the button the danger style; every caller names it (confirm_census), a question that loses nothing keeps the primary. */
export function showConfirmModal(title, message, onConfirm, onCancel, opts = {}) {
    _dismissConfirm(); // a modal replaced before an answer counts as cancelled
    document.getElementById("confirm-modal-title").textContent = title;
    document.getElementById("confirm-modal-message").textContent = message;
    const yesBtn = document.getElementById("confirm-modal-yes");
    const newBtn = yesBtn.cloneNode(true);
    newBtn.textContent = opts.label || 'Yes';
    newBtn.className = opts.danger === true ? 'btn btn-danger' : 'btn btn-primary'; // set on every call: the template's class is not kept
    const noBtn = document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)'); if (noBtn) noBtn.textContent = opts.cancelLabel || 'Cancel'; // the stay button's words, put back to Cancel for every other question
    yesBtn.parentNode.replaceChild(newBtn, yesBtn);
    newBtn.addEventListener("click", () => {
        _confirmCancel = null;
        hideConfirmModal();
        onConfirm();
    });
    _confirmCancel = onCancel || null;
    document.getElementById("confirm-modal").style.display = "flex";
}

function _dismissConfirm() {
    const cancel = _confirmCancel;
    _confirmCancel = null;
    if (cancel) cancel();
}

export function hideConfirmModal() {
    _dismissConfirm();
    const modal = document.getElementById("confirm-modal");
    modal.style.display = "none";
}
