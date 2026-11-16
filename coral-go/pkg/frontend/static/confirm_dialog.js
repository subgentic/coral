/* Moved out of render.js as it was (#3795): no behaviour change. */

// Called when the open confirm modal is dismissed without confirming.
let _confirmCancel = null;

/** opts.acknowledge: a sentence the person must tick before the confirming button works (an unticked box under the message, #391's
 *  nested-shell record); onConfirm then gets true. opts.choice {label, checked}: an optional tick that does not gate the button; onConfirm gets its state second (#17150). opts.label: the confirming button's word, the action ("Delete panel", "Sleep agent"): every caller passes it (confirm_census), so no question is answered with Yes. opts.danger: true makes the button the danger style; every caller names it (confirm_census), a question that loses nothing keeps the primary. */
export function showConfirmModal(title, message, onConfirm, onCancel, opts = {}) {
    _dismissConfirm(); // a modal replaced before an answer counts as cancelled
    document.getElementById("confirm-modal-title").textContent = title;
    const msg = document.getElementById("confirm-modal-message");
    msg.textContent = message;
    document.getElementById("confirm-modal-ack")?.remove(); // each question starts without a box, or with a new unticked one
    document.getElementById("confirm-modal-choice")?.remove();
    const yesBtn = document.getElementById("confirm-modal-yes");
    const newBtn = yesBtn.cloneNode(true);
    newBtn.textContent = opts.label || 'Confirm'; // every caller names the action (confirm_census); the fallback is not a Yes
    newBtn.className = opts.danger === true ? 'btn btn-danger' : 'btn btn-primary'; // set on every call: the template's class is not kept
    const noBtn = document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)'); if (noBtn) noBtn.textContent = opts.cancelLabel || 'Cancel'; // the stay button's words, put back to Cancel for every other question
    yesBtn.parentNode.replaceChild(newBtn, yesBtn);
    let ack = null;
    if (opts.acknowledge) {
        const label = document.createElement('label');
        label.id = 'confirm-modal-ack';
        label.className = 'confirm-modal-ack';
        ack = document.createElement('input');
        ack.type = 'checkbox';
        label.append(ack, ' ', String(opts.acknowledge));
        msg.after(label);
        newBtn.disabled = true;
        ack.addEventListener('change', () => { newBtn.disabled = !ack.checked; });
    }
    let choice = null;
    if (opts.choice) { // an option of the answer, not a condition of it: the button works either way, and onConfirm gets its state as the second argument (#17150)
        const label = document.createElement('label');
        label.id = 'confirm-modal-choice';
        label.className = 'confirm-modal-ack';
        choice = document.createElement('input');
        choice.type = 'checkbox';
        choice.checked = !!opts.choice.checked;
        label.append(choice, ' ', String(opts.choice.label));
        (document.getElementById("confirm-modal-ack") || msg).after(label);
    }
    newBtn.addEventListener("click", () => {
        if (ack && !ack.checked) return;
        _confirmCancel = null;
        const chose = !!(choice && choice.checked);
        hideConfirmModal();
        onConfirm(!!(ack && ack.checked), chose);
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
