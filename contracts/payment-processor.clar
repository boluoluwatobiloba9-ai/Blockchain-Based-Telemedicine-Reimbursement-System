(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-AMOUNT u101)
(define-constant ERR-INSUFFICIENT-FUNDS u102)
(define-constant ERR-SERVICE-NOT-FOUND u103)
(define-constant ERR-ALREADY-PAID u104)
(define-constant ERR-INVALID-SESSION-HASH u105)
(define-constant ERR-INVALID-VERIFICATION u106)
(define-constant ERR-FUNDER-NOT-FOUND u107)
(define-constant ERR-INVALID-TIMESTAMP u108)
(define-constant ERR-AUTHORITY-NOT-VERIFIED u109)
(define-constant ERR-INVALID-PAYMENT-STATUS u110)

(define-data-var authority-contract (optional principal) none)
(define-data-var max-payment-amount uint u1000000)
(define-data-var min-payment-amount uint u100)
(define-data-var payment-fee uint u500)

(define-map payments
  uint
  {
    session-id: uint,
    provider: principal,
    patient: principal,
    amount: uint,
    timestamp: uint,
    status: (string-utf8 20),
    funder: principal,
    session-hash: (buff 32)
  }
)

(define-map payment-status
  uint
  bool
)

(define-map fund-balances
  principal
  uint
)

(define-read-only (get-payment (payment-id uint))
  (map-get? payments payment-id)
)

(define-read-only (get-fund-balance (funder principal))
  (default-to u0 (map-get? fund-balances funder))
)

(define-read-only (get-payment-status (payment-id uint))
  (default-to false (map-get? payment-status payment-id))
)

(define-private (validate-amount (amount uint))
  (if (and (>= amount (var-get min-payment-amount)) (<= amount (var-get max-payment-amount)))
      (ok true)
      (err ERR-INVALID-AMOUNT))
)

(define-private (validate-session-hash (hash (buff 32)))
  (if (> (len hash) u0)
      (ok true)
      (err ERR-INVALID-SESSION-HASH))
)

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height)
      (ok true)
      (err ERR-INVALID-TIMESTAMP))
)

(define-private (validate-principal (p principal))
  (if (not (is-eq p 'SP000000000000000000002Q6VF78))
      (ok true)
      (err ERR-NOT-AUTHORIZED))
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (try! (validate-principal contract-principal))
    (asserts! (is-none (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set authority-contract (some contract-principal))
    (ok true)
  )
)

(define-public (set-max-payment-amount (new-max uint))
  (begin
    (asserts! (> new-max u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set max-payment-amount new-max)
    (ok true)
  )
)

(define-public (set-min-payment-amount (new-min uint))
  (begin
    (asserts! (> new-min u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set min-payment-amount new-min)
    (ok true)
  )
)

(define-public (set-payment-fee (new-fee uint))
  (begin
    (asserts! (>= new-fee u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set payment-fee new-fee)
    (ok true)
  )
)

(define-public (process-payment
  (session-id uint)
  (provider principal)
  (patient principal)
  (amount uint)
  (session-hash (buff 32))
  (funder principal)
)
  (let
    (
      (payment-id (var-get next-payment-id))
      (current-balance (get-fund-balance funder))
      (authority (var-get authority-contract))
    )
    (asserts! (is-some authority) (err ERR-AUTHORITY-NOT-VERIFIED))
    (try! (validate-amount amount))
    (try! (validate-session-hash session-hash))
    (try! (validate-timestamp block-height))
    (asserts! (>= current-balance (+ amount (var-get payment-fee))) (err ERR-INSUFFICIENT-FUNDS))
    (asserts! (not (get-payment-status payment-id)) (err ERR-ALREADY-PAID))
    (try! (contract-call? .service-registry verify-service session-id patient session-hash))
    (try! (contract-call? .patient-verifier is-verified session-id patient))
    (let ((authority-recipient (unwrap! authority (err ERR-AUTHORITY-NOT-VERIFIED))))
      (try! (stx-transfer? amount tx-sender provider))
      (try! (stx-transfer? (var-get payment-fee) tx-sender authority-recipient))
    )
    (map-set payments payment-id
      {
        session-id: session-id,
        provider: provider,
        patient: patient,
        amount: amount,
        timestamp: block-height,
        status: u"completed",
        funder: funder,
        session-hash: session-hash
      }
    )
    (map-set payment-status payment-id true)
    (map-set fund-balances funder (- current-balance (+ amount (var-get payment-fee))))
    (print { event: "payment-processed", id: payment-id, session-id: session-id })
    (ok payment-id)
  )
)

(define-public (update-fund-balance (funder principal) (amount uint))
  (begin
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (try! (validate-amount amount))
    (map-set fund-balances funder (+ (get-fund-balance funder) amount))
    (print { event: "fund-balance-updated", funder: funder, amount: amount })
    (ok true)
  )
)

(define-data-var next-payment-id uint u0)

(define-public (increment-payment-id)
  (begin
    (var-set next-payment-id (+ (var-get next-payment-id) u1))
    (ok (var-get next-payment-id))
  )
)