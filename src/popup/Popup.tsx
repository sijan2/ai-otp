import { Button, buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'

export default function MyExtension() {
  return (
    <div className='h-40 w-80'>
      <Button
        type='button'
        className={cn(buttonVariants({ variant: 'outline' }))}
      >
        Login with Google
      </Button>
    </div>
  )
}
