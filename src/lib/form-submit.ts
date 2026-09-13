import { startTransition, type FormEvent } from "react";

// React resets a form after its `action` runs, even when the action answers with field
// errors, which would clear what the owner typed. Forms keep `action` (so a submit before
// hydration still works) and also call this from onSubmit: it stops React's own dispatch
// and runs the same action in a transition, without the reset.
export function dispatchFormData(event: FormEvent<HTMLFormElement>, dispatch: (formData: FormData) => void): void {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  startTransition(() => dispatch(formData));
}
