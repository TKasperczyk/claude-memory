import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const sizeMap = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
}

interface ButtonSpinnerProps {
  size?: keyof typeof sizeMap
  className?: string
}

export default function ButtonSpinner({ size = 'sm', className }: ButtonSpinnerProps) {
  return <Loader2 className={cn('animate-spin', sizeMap[size], className)} />
}
