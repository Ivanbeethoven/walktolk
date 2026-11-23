/** Keep the desktop answerer available while the same question is on the deck. */
export async function askOnBoth(request, card, board, next) {
  const original = request.signal;
  const local = new AbortController();
  const remote = new AbortController();
  const join = controller => original ? AbortSignal.any([original, controller.signal]) : controller.signal;
  const cardWait = board.ask(card, join(local)).then(choice => ({ source: 'deck', choice }));
  // Cordis passes this same request to the next scoped listener.
  request.signal = join(remote);
  const phoneWait = Promise.resolve().then(next).then(
    value => ({ source: 'phone', value }),
    error => ({ source: 'unavailable', error }),
  );
  try {
    let result = await Promise.race([cardWait, phoneWait]);
    if (result.source === 'unavailable') {
      const deck = await cardWait;
      if (deck.choice === null) throw result.error;
      result = deck;
    } else if (result.source === 'deck' && result.choice === null) {
      result = await phoneWait;
      if (result.source === 'unavailable') throw result.error;
    }
    original?.throwIfAborted();
    if (result.source === 'phone') return result.value;
    return { answers: [{ id: card.questionId, selected: [card.choices[result.choice]] }] };
  } finally {
    local.abort();
    remote.abort();
    request.signal = original;
  }
}
